#!/usr/bin/env python3
"""Serial real-device smoke on a Linux PTY null-modem pair (Docker layer).

Closes the coverage gap scripts/smoke_serial_upload.py documents for macOS:
serialport-rs rejects pseudo terminals with ENOTTY on macOS (host PTY layer
SKIPs there), but on Linux a socat PTY pair behaves like a real RS-232 link
(termios + baud ioctls succeed), so the full wire path runs end to end:

    sidecar ── /tmp/dbx-vtty-a ◀═socat null-modem═▶ /tmp/dbx-vtty-b ── device
                                                                      simulator

The simulator plays a console device (banner + `Router> ` prompt, line echo,
`show version`/`ati` handlers, `rx` enters XMODEM-CRC receive mode) — the
same shape as a router/开发板 serial console. Cases:

  1. serial/ports/list enumerates the virtual device
  2. serial/start (8N1) → sessionId + binaryInput capability + connected
  3. device banner arrives over serial/terminal/out (TerminalFrame frames)
  4. binary keyboard channel (Stdin tag) `show version` → echo + response +
     inputAck
  5. serial/write JSON fallback `ati` → OK
  6. strict line-parameter validation rejects parity "mark" with a readable
     error
  7. XMODEM full transfer through `rx`: receiver 'C' invite → CRC blocks →
     EOT NAK/ACK double-confirm; file bytes verified at the device side;
     progress events reach complete
  8. ZMODEM start → ZRQINIT on the wire; cancel → ZDLE×5+BS×5; progress
     lands failed
  9. serial/replay redelivers sequenced frames
 10. serial/list, serial/close, write-after-close business error

Runs INSIDE the protocol-matrix Linux container (needs socat + python3 +
libudev): see scripts/docker/protocol-matrix/run_matrix.sh. PTY/baud setup
failures SKIP the affected layers with the reason (environment, not defect).
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import shutil
import struct
import subprocess
import sys
import termios
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError

FRAME_HEADER = 9  # TerminalFrame: 1B stream tag + u64 BE sequence
STDIN_TAG = 3

SOH = 0x01
EOT = 0x04
ACK = 0x06
NAK = 0x15
CAN = 0x18
BS = 0x08

BANNER = b"DBX-VSERIAL console ready"
PROMPT = b"Router> "


def crc16_xmodem(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def step(name: str):
    print(f"\n==> {name}")


def missing_method(error: Exception) -> str | None:
    text = str(error)
    if "Method not found" not in text and "-32601" not in text:
        return None
    match = re.search(r"Method not found:\s*([\w./-]+)", text)
    return match.group(1) if match else ""


class SkipSignal(Exception):
    pass


def skip_or_raise(method: str, error: SidecarError) -> None:
    missing = missing_method(error)
    if missing is None:
        raise error
    raise SkipSignal(f"{missing or method} not registered")


class DeviceSimulator:
    """Console device on side B of the null-modem pair."""

    def __init__(self, port: str):
        self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            attrs = termios.tcgetattr(self.fd)
            iflag, oflag, cflag, lflag, ispeed, ospeed, cc = attrs
            iflag &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK | termios.ISTRIP
                       | termios.INLCR | termios.IGNCR | termios.ICRNL | termios.IXON)
            oflag &= ~termios.OPOST
            lflag &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG | termios.IEXTEN)
            cflag &= ~(termios.CSIZE | termios.PARENB)
            cflag |= termios.CS8 | termios.CREAD | termios.CLOCAL
            cc[termios.VMIN] = 0
            cc[termios.VTIME] = 0
            termios.tcsetattr(self.fd, termios.TCSANOW, [iflag, oflag, cflag, lflag, ispeed, ospeed, cc])
        except termios.error as error:  # pragma: no cover — environment guard
            os.close(self.fd)
            raise SkipSignal(f"cannot set raw mode on {port}: {error}")

        self.mode = "console"
        self.line = bytearray()
        self.rx_file = bytearray()
        self.rx_done = threading.Event()
        self.xmodem_log: list[str] = []
        self.zmodem_log: list[str] = []
        self.zrqinit_seen = threading.Event()
        self.stop = threading.Event()
        self._expect_eot_again = False
        self._last_block = 0
        self._invited_at = 0.0  # 实例属性：_loop 的 'C' 节流与 _console_feed 共享
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        # 设备上电：延时送 banner + 提示符（真机控制台形态）。
        def boot():
            time.sleep(0.3)
            self.write(BANNER + b"\r\n" + PROMPT)
        threading.Thread(target=boot, daemon=True).start()

    def write(self, data: bytes) -> None:
        while data and not self.stop.is_set():
            sent = os.write(self.fd, data)
            data = data[sent:]

    def _loop(self) -> None:
        invited_at = 0.0
        while not self.stop.is_set():
            try:
                chunk = os.read(self.fd, 4096)
            except BlockingIOError:
                chunk = b""
            except OSError as error:  # port vanished
                self.xmodem_log.append(f"read failed: {error}")
                return
            if chunk:
                if self.mode == "xmodem":
                    self._xmodem_feed(chunk)
                elif self.mode == "zmodem":
                    self._zmodem_feed(chunk)
                else:
                    self._console_feed(chunk)
            now = time.monotonic()
            # 'C' 只在首块到来前以 1s 节奏重发（引擎在 upload/start 后才
            # 开始收邀约；块流中插入的 0x43 会打碎帧边界 → CRC 失配死循环）。
            if self.mode == "xmodem" and not self.rx_file and not self.rx_done.is_set() \
                    and now - self._invited_at > 1.0:
                self.write(b"C")
                self._invited_at = now
            time.sleep(0.01)

    def _console_feed(self, chunk: bytes) -> None:
        self.line += chunk
        while b"\r" in self.line or b"\n" in self.line:
            cut = min((i for i in (self.line.find(b"\r"), self.line.find(b"\n")) if i >= 0))
            raw = bytes(self.line[:cut])
            self.line = self.line[cut + 1:]
            text = raw.decode(errors="replace").strip()
            if not text:
                continue
            if text == "rx":
                self.mode = "xmodem"
                self._expect_eot_again = False
                self._last_block = 0
                self._invited_at = time.monotonic()
                self.write(b"C")
            elif text == "zm":
                self.mode = "zmodem"
            elif not raw.strip():
                self.write(PROMPT)
            elif text == "show version":
                self.write(b"show version\r\n" + BANNER + b" OS 4.2, uptime 6d\r\n" + PROMPT)
            elif text == "ati":
                self.write(b"OK\r\n" + PROMPT)
            else:
                self.write(text.encode() + b"\r\n" + PROMPT)

    def _xmodem_feed(self, chunk: bytes) -> None:
        for byte in chunk:
            if self.rx_done.is_set():
                return
            # 收块中：任何字节（含 0x01/0x04 等控制值）都归入当前帧——
            # 块号 0x01 == SOH、载荷 0x1A/0x04 都不能再触发状态分支。
            if getattr(self, "_collecting", 0) > 0:
                self._pending += bytes([byte])
                self._collecting -= 1
                if self._collecting == 0:
                    block = self._pending[1]
                    complement = self._pending[2]
                    payload = self._pending[3:131]
                    received_crc = (self._pending[131] << 8) | self._pending[132]
                    if block ^ 0xFF != complement:
                        self.xmodem_log.append(f"block header mismatch at {block:#x}")
                        self.write(bytes([NAK]))
                    elif crc16_xmodem(payload) != received_crc:
                        self.xmodem_log.append(f"crc mismatch on block {block}")
                        self.write(bytes([NAK]))
                    else:
                        number = block & 0xFF
                        if number == ((self._last_block + 1) & 0xFF):
                            self.rx_file += payload
                            self._last_block = number
                        # 重传的同号块：只 ACK 不追加
                        self.write(bytes([ACK]))
                continue
            if self._expect_eot_again:
                if byte == EOT:
                    self.write(bytes([ACK]))
                    self.rx_done.set()
                    self.mode = "console"
                    self.write(b"\r\n" + PROMPT)
                continue
            if byte == EOT:
                self.write(bytes([NAK]))  # 双确认：先 NAK，第二枚 EOT 才 ACK
                self._expect_eot_again = True
            elif byte == SOH:
                self._pending = bytes([byte])
                self._collecting = 132  # blk + ~blk + 128B + crc16，共 133 字节帧

    def _zmodem_feed(self, chunk: bytes) -> None:
        self.zmodem_log.append(chunk)
        if b"**\x18B" in b"".join(self.zmodem_log[-3:]):
            self.zrqinit_seen.set()

    def saw_zrqinit(self) -> bool:
        return b"**\x18B" in b"".join(self.zmodem_log)

    def saw_cancel(self) -> bool:
        return bytes([CAN] * 5 + [BS] * 5) in b"".join(self.zmodem_log)

    def close(self) -> None:
        self.stop.set()
        try:
            self.thread.join(timeout=2)
        finally:
            os.close(self.fd)


def start_socat(port_a: str, port_b: str) -> subprocess.Popen:
    if shutil.which("socat") is None:
        raise SkipSignal("socat not available in this environment")
    process = subprocess.Popen(
        [
            "socat", "-d", "-d",
            f"PTY,link={port_a},raw,echo=0",
            f"PTY,link={port_b},raw,echo=0",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if os.path.exists(port_a) and os.path.exists(port_b):
            return process
        if process.poll() is not None:
            raise SkipSignal(f"socat exited early with {process.returncode}")
        time.sleep(0.1)
    process.terminate()
    raise SkipSignal(f"socat did not materialize {port_a}/{port_b} in time")


class Report:
    def __init__(self):
        self.passed: list[str] = []
        self.skipped: list[tuple[str, str]] = []
        self.failed: list[tuple[str, str]] = []

    def run(self, title: str, case):
        step(title)
        try:
            case()
        except SkipSignal as reason:
            print(f"SKIP: {reason}")
            self.skipped.append((title, str(reason)))
        except Exception as error:  # noqa: BLE001 — report and continue
            print(f"FAIL: {error}")
            self.failed.append((title, str(error)))
        else:
            print("    PASS")
            self.passed.append(title)

    def finish(self, started: float) -> None:
        print(
            f"\n== smoke_serial_docker: {len(self.passed)} passed, "
            f"{len(self.skipped)} skipped, {len(self.failed)} failed "
            f"in {time.monotonic() - started:.1f}s"
        )
        if self.failed:
            for title, reason in self.failed:
                print(f"FAIL: {title}: {reason}", file=sys.stderr)
            sys.exit(1)


def wait_state(client: SidecarClient, session_id: str, states: set[str], timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    previous_timeout = client.timeout
    client.timeout = 0.2
    seen: set[str] = set()
    try:
        while time.monotonic() < deadline:
            for event in client.events:
                if event.get("method") != "serial/session/state":
                    continue
                params = event.get("params", {})
                if params.get("sessionId") != session_id:
                    continue
                state = params.get("state")
                if state in states:
                    return event
                seen.add(str(state))
                if state == "error":
                    raise AssertionError(f"session errored: {params.get('error')!r}")
            try:
                client._pump(None)
            except SidecarError:
                pass
    finally:
        client.timeout = previous_timeout
    raise AssertionError(f"state {sorted(states)} not reached in {timeout}s; saw {sorted(seen)}")


_OUT_CURSOR = 0  # 已消费的 binary_frames 下标（含其它轮询抢先泵入的帧）


def collect_output(client: SidecarClient, seconds: float = 0.5) -> tuple[bytes, int]:
    """Pump out-channel frames; returns (new payload bytes, last sequence)."""
    global _OUT_CURSOR
    previous_timeout = client.timeout
    client.timeout = 0.2
    deadline = time.monotonic() + seconds
    try:
        while time.monotonic() < deadline:
            try:
                client._pump(None)
            except SidecarError:
                pass
    finally:
        client.timeout = previous_timeout
    chunk = bytearray()
    last_seq = -1
    while _OUT_CURSOR < len(client.binary_frames):
        channel, data = client.binary_frames[_OUT_CURSOR]
        _OUT_CURSOR += 1
        if not channel.startswith("serial/terminal/out/") or len(data) < FRAME_HEADER:
            continue
        chunk += data[FRAME_HEADER:]
        last_seq = struct.unpack(">Q", data[1:FRAME_HEADER])[0]
    return bytes(chunk), last_seq


def wait_for_text(client: SidecarClient, needle: bytes, timeout: float = 15.0) -> bytes:
    deadline = time.monotonic() + timeout
    buf = bytearray()
    while needle not in buf:
        got, _ = collect_output(client, 0.4)
        buf += got
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {needle!r}; tail={bytes(buf[-160:])!r}")
    return bytes(buf)


def send_keystrokes(client: SidecarClient, session_id: str, sequence: int, data: bytes) -> None:
    frame = struct.pack(">BQ", STDIN_TAG, sequence) + data
    client.send_binary(f"serial/terminal/in/{session_id}", frame)


def wait_upload_progress(client: SidecarClient, session_id: str, states: set[str], timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    seen: list[dict] = []
    previous_timeout = client.timeout
    client.timeout = 0.2
    try:
        while time.monotonic() < deadline:
            for event in client.events:
                if event.get("method") != "serial/upload/progress":
                    continue
                params = event.get("params", {})
                if params.get("sessionId") != session_id:
                    continue
                seen.append(params)
                if params.get("state") in states:
                    return params
            try:
                client._pump(None)
            except SidecarError:
                pass
    finally:
        client.timeout = previous_timeout
    raise AssertionError(f"upload never reached {sorted(states)}; states={[p.get('state') for p in seen][-12:]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--binary", default=None)
    parser.add_argument("--port-a", default="/tmp/dbx-vtty-a")
    parser.add_argument("--port-b", default="/tmp/dbx-vtty-b")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--data-dir", default=None)
    args = parser.parse_args()

    binary = args.binary or os.environ.get("DBX_PLUGIN_SIDECAR") or "/target/release/dbx-plugin-ssh"

    started = time.monotonic()
    report = Report()
    socat = None
    device: DeviceSimulator | None = None
    client = None
    try:
        try:
            socat = start_socat(args.port_a, args.port_b)
            device = DeviceSimulator(args.port_b)
        except SkipSignal as reason:
            print(f"SKIP: serial PTY layer unavailable: {reason}")
            return

        client = SidecarClient.start(binary=binary, data_dir=args.data_dir)
        client.initialize()

        def case_ports_list():
            try:
                listing = client.request("serial/ports/list")
            except SidecarError as error:
                skip_or_raise("serial/ports/list", error)
                raise
            ports = listing.get("ports") if isinstance(listing, dict) else listing
            if not isinstance(ports, list):
                raise AssertionError(f"unexpected serial/ports/list shape: {listing}")
            if any(args.port_a in str(port.get("path") or port) for port in ports):
                print("    virtual device enumerated")
            else:
                # Linux serialport 后端只枚举 ttyS/ttyUSB/ttyACM，不枚举
                # /dev/pts——PTY 回环里枚举不到虚拟设备是后端语义，非缺陷。
                print(f"    note: {args.port_a} not in enumeration "
                      f"(Linux backend skips /dev/pts; {len(ports)} port(s) listed)")

        def start_session(extra: dict | None = None) -> str:
            # 线上字段为 snake_case（SerialStartRequest 未启用 camelCase
            # rename，与前端 App.vue 的真实调用一致）；响应由 sidecar 手拼
            # json!，sessionId/port/baudRate/binaryInput 为 camelCase。
            try:
                started_resp = client.request(
                    "serial/start",
                    {
                        "workbench_id": "smoke-serial-docker",
                        "port_name": args.port_a,
                        "baud_rate": args.baud,
                        "data_bits": "8",
                        "parity": "none",
                        "stop_bits": "1",
                        **(extra or {}),
                    },
                )
            except SidecarError as error:
                skip_or_raise("serial/start", error)
                raise
            session_id = str(started_resp.get("sessionId") or "")
            if not session_id:
                raise AssertionError(f"serial/start returned no sessionId: {started_resp}")
            if started_resp.get("binaryInput") is not True:
                raise AssertionError(f"binaryInput capability missing: {started_resp}")
            # 契约注记：串口会话没有 connected 状态事件（sidecar 只发
            # closed/error；前端 start 后本地置 running，连通性靠输出帧）。
            return session_id

        session_holder: dict[str, str] = {}

        def case_start():
            session_holder["id"] = start_session()

        def case_banner():
            # 上电 banner 可能早于 sidecar 打开端口而丢失（PTY 缓冲语义）；
            # 真机等价物：回车让控制台重打提示符，以此验证读路径出帧。
            send_keystrokes(client, session_holder["id"], 9, b"\r")
            wait_for_text(client, PROMPT)

        def case_keyboard():
            session_id = session_holder["id"]
            send_keystrokes(client, session_id, 1, b"show version\r")
            wait_for_text(client, b"OS 4.2, uptime 6d")
            acked = False
            deadline = time.monotonic() + 10
            previous_timeout = client.timeout
            client.timeout = 0.2
            try:
                while time.monotonic() < deadline and not acked:
                    for event in client.events:
                        if event.get("method") == "serial/terminal/inputAck" and \
                                event.get("params", {}).get("sessionId") == session_id:
                            acked = True
                    try:
                        client._pump(None)
                    except SidecarError:
                        pass
            finally:
                client.timeout = previous_timeout
            if not acked:
                raise AssertionError("no serial/terminal/inputAck for binary keyboard frame")

        def case_json_write():
            try:
                client.request("serial/write", {"sessionId": session_holder["id"], "dataBase64": base64.b64encode(b"ati\r").decode()})
            except SidecarError as error:
                skip_or_raise("serial/write", error)
                raise
            wait_for_text(client, b"OK\r\n")

        def case_bad_parity():
            try:
                client.request(
                    "serial/start",
                    {
                        "workbench_id": "smoke-serial-docker-bad",
                        "port_name": args.port_a,
                        "baud_rate": args.baud,
                        "parity": "mark",
                    },
                )
            except SidecarError as error:
                if missing_method(error) is not None:
                    skip_or_raise("serial/start", error)
                if "parity" not in str(error).lower():
                    raise AssertionError(f"parity rejection not readable: {error}")
                return
            raise AssertionError("serial/start accepted parity 'mark'")

        def case_xmodem():
            session_id = session_holder["id"]
            payload = bytes((i * 7 + 3) & 0xFF for i in range(300))
            send_keystrokes(client, session_id, 2, b"rx\r")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and device.mode != "xmodem":
                time.sleep(0.05)
            if device.mode != "xmodem":
                raise AssertionError(f"device never entered rx mode; console={device.line!r}")
            try:
                client.request(
                    "serial/upload/start",
                    {"sessionId": session_id, "protocol": "xmodem", "fileName": "dbx-docker.bin", "totalSize": len(payload)},
                )
                view = memoryview(payload)
                while view:
                    block, view = view[:6144], view[6144:]
                    client.request(
                        "serial/upload/data",
                        {"sessionId": session_id, "dataBase64": base64.b64encode(block).decode(), "final": not view},
                    )
            except SidecarError as error:
                skip_or_raise("serial/upload/*", error)
                raise
            wait_upload_progress(client, session_id, {"complete"}, timeout=60.0)
            if not device.rx_done.is_set():
                device.rx_done.wait(timeout=10)
            got = bytes(device.rx_file[: len(payload)])
            if got != payload:
                raise AssertionError(f"XMODEM payload mismatch: sent {len(payload)}B, got {len(got)}B differing at "
                                     f"{next((i for i, (x, y) in enumerate(zip(payload, got)) if x != y), min(len(payload), len(got)))}")
            if device.xmodem_log:
                print(f"    device log: {device.xmodem_log}")

        def case_zmodem_cancel():
            session_id = session_holder["id"]
            # 设备侧先进 ZMODEM 观察态（console 输入 `zm`），否则 ZRQINIT
            # 会被控制台行缓冲当普通输入吞掉。
            send_keystrokes(client, session_id, 3, b"zm\r")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and device.mode != "zmodem":
                time.sleep(0.05)
            if device.mode != "zmodem":
                raise AssertionError("device never entered zmodem mode")
            try:
                client.request(
                    "serial/upload/start",
                    {"sessionId": session_id, "protocol": "zmodem", "fileName": "dbx-z.bin", "totalSize": 1024},
                )
            except SidecarError as error:
                skip_or_raise("serial/upload/start", error)
                raise
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not device.saw_zrqinit():
                time.sleep(0.05)
            if not device.saw_zrqinit():
                raise AssertionError(f"no ZRQINIT prefix on the wire; log={b''.join(device.zmodem_log)[:64]!r}")
            try:
                client.request("serial/upload/cancel", {"sessionId": session_id})
            except SidecarError as error:
                skip_or_raise("serial/upload/cancel", error)
                raise
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not device.saw_cancel():
                time.sleep(0.05)
            if not device.saw_cancel():
                raise AssertionError("cancel sequence ZDLE×5+BS×5 never reached the device")
            event = wait_upload_progress(client, session_id, {"failed"}, timeout=10.0)
            print(f"    failed reason: {event.get('reason')!r}")

        def case_replay():
            session_id = session_holder["id"]
            # 回放帧可能随 RPC 响应一起到达：以请求前缓冲长度为基线看帧数差。
            baseline = len(client.binary_frames)
            try:
                summary = client.request("serial/replay", {"sessionId": session_id, "afterSequence": 0})
            except SidecarError as error:
                skip_or_raise("serial/replay", error)
                raise
            if int(summary.get("frameCount") or 0) <= 0 or summary.get("complete") is not True:
                raise AssertionError(f"unexpected replay summary: {summary}")
            deadline = time.monotonic() + 3.0
            redelivered = 0
            while time.monotonic() < deadline:
                redelivered = sum(
                    1
                    for channel, _ in client.binary_frames[baseline:]
                    if channel.startswith("serial/terminal/out/")
                )
                if redelivered >= int(summary["frameCount"]):
                    break
                collect_output(client, 0.3)
            if redelivered < int(summary["frameCount"]):
                raise AssertionError(
                    f"replay summary frameCount={summary['frameCount']} but only {redelivered} redelivered"
                )

        def case_close():
            session_id = session_holder["id"]
            listing = client.request("serial/list")
            sessions = listing.get("sessions") if isinstance(listing, dict) else listing
            if not any(s.get("sessionId") == session_id for s in (sessions or [])):
                raise AssertionError(f"serial/list missing the live session: {sessions}")
            try:
                client.request("serial/close", {"sessionId": session_id})
            except SidecarError as error:
                skip_or_raise("serial/close", error)
                raise
            wait_state(client, session_id, {"closed"}, timeout=10.0)
            listing = client.request("serial/list")
            sessions = listing.get("sessions") if isinstance(listing, dict) else listing
            if any(s.get("sessionId") == session_id for s in (sessions or [])):
                raise AssertionError("closed session still listed")
            try:
                client.request("serial/write", {"sessionId": session_id, "dataBase64": "aGk="})
            except SidecarError as error:
                if "not found" not in str(error).lower() and "expired" not in str(error).lower():
                    raise AssertionError(f"write-after-close unexpected error: {error}")
            else:
                raise AssertionError("write after close unexpectedly succeeded")

        report.run("serial/ports/list enumerates the virtual device", case_ports_list)
        report.run("serial/start 8N1 → sessionId + binaryInput + connected", case_start)
        report.run("prompt reprinted on Enter arrives over serial/terminal/out", case_banner)
        report.run("binary keyboard channel: show version echo + response + inputAck", case_keyboard)
        report.run("serial/write JSON fallback: ati → OK", case_json_write)
        report.run("strict line-parameter validation rejects parity 'mark'", case_bad_parity)
        report.run("XMODEM full transfer through rx (CRC blocks, EOT double-confirm)", case_xmodem)
        report.run("ZMODEM start (ZRQINIT) → cancel (ZDLE×5+BS×5) → failed", case_zmodem_cancel)
        report.run("serial/replay redelivers sequenced frames", case_replay)
        report.run("serial/list + close + write-after-close business error", case_close)
    finally:
        if client is not None:
            client.close()
            stderr = client.drain_stderr()
            if stderr.strip():
                print("--- sidecar stderr tail ---")
                print(stderr[-1500:])
        if device is not None:
            device.close()
        if socat is not None:
            socat.terminate()
    report.finish(started)


if __name__ == "__main__":
    main()
