#!/usr/bin/env python3
"""Telnet real-server smoke (protocol-matrix Docker layer, nyaterm parity).

Drives the sidecar's telnet session family against a REAL telnet server in
Docker (scripts/docker/protocol-matrix/Dockerfile.telnetd, busybox telnetd):
unlike scripts/smoke_telnet_autologin.py (pure start-time validation, no
network), this exercises the full wire path — real IAC negotiation (DO ECHO /
DO NAWS / WILL ECHO / WILL SGA from the server), NAWS window-size reply, the
declarative auto-login Expect engine against busybox `login`, the sequenced
binary keyboard channel, the JSON write fallback, replay and close.

Flavors:
  shell      telnetd -l /bin/sh      — no auth; IAC/NAWS/keyboard/replay/close
  login      telnetd -l /bin/login   — declarative auto-login types the real
                                       username/password through busybox login
                                       to a shell (successRegex `DBXSHELL> `);
                                       also asserts the password bytes never
                                       echo back
  login-fail telnetd -l /bin/login   — wrong password; failureRegex must be
                                       observed and the session torn down with
                                       a readable reason once the retry budget
                                       is exhausted

Unreachable server → the whole run SKIPs (environment, not a defect); an
unregistered method SKIPs individual cases (smoke convention). Test
credentials belong to the throwaway container only (same tier as CI's
DbxTest2026).

Usage:
    python3 scripts/smoke_telnet_docker.py --flavor shell  --port 2324
    python3 scripts/smoke_telnet_docker.py --flavor login  --port 2323
    DBX_PLUGIN_SIDECAR=/path/to/dbx-plugin-ssh python3 scripts/smoke_telnet_docker.py ...
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import socket
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sidecar_client import SidecarClient, SidecarError

FRAME_HEADER = 9  # TerminalFrame: 1B stream tag + u64 BE sequence
OUT_CHANNEL = "telnet/terminal/out/"
IN_CHANNEL = "telnet/terminal/in/"
STATE_EVENT = "telnet/session/state"

LOGIN_USER = "dbxuser"
LOGIN_PASSWORD = "DbxTelnet2026"
LOGIN_PROMPT = "DBXSHELL> "


def step(name: str):
    print(f"\n==> {name}")


def missing_method(error: Exception) -> str | None:
    text = str(error)
    if "Method not found" not in text and "-32601" not in text:
        return None
    match = re.search(r"Method not found:\s*([\w./-]+)", text)
    return match.group(1) if match else ""


class SkipSignal(Exception):
    """Raised by a case to skip itself (environment or unregistered method)."""


def skip_or_raise(method: str, error: SidecarError) -> None:
    missing = missing_method(error)
    if missing is None:
        raise error
    raise SkipSignal(f"{missing or method} not registered")


class OutputCollector:
    """Accumulates decoded TerminalFrame payloads from the out channel."""

    def __init__(self, client: SidecarClient, session_id: str):
        self.client = client
        self.prefix = OUT_CHANNEL + session_id
        self.cursor = 0  # 已消费的 binary_frames 下标（含其它轮询抢先泵入的帧）
        self.text = bytearray()
        self.sequences: list[int] = []

    def drain(self, seconds: float) -> bytes:
        """Pump frames for up to `seconds`; returns bytes newly decoded."""
        previous_timeout = self.client.timeout
        self.client.timeout = 0.2
        deadline = time.monotonic() + seconds
        try:
            while time.monotonic() < deadline:
                try:
                    self.client._pump(None)
                except SidecarError:
                    pass
        finally:
            self.client.timeout = previous_timeout
        return self.flush()

    def flush(self) -> bytes:
        chunk = bytearray()
        while self.cursor < len(self.client.binary_frames):
            channel, data = self.client.binary_frames[self.cursor]
            self.cursor += 1
            if not channel.startswith(self.prefix) or len(data) < FRAME_HEADER:
                continue
            payload = data[FRAME_HEADER:]
            self.sequences.append(struct.unpack(">Q", data[1:FRAME_HEADER])[0])
            chunk += payload
            self.text += payload
        return bytes(chunk)

    def wait_for(self, needle: bytes, timeout: float = 15.0) -> bytes:
        deadline = time.monotonic() + timeout
        while needle not in self.text:
            self.drain(0.5)
            if time.monotonic() > deadline:
                tail = bytes(self.text[-160:])
                raise AssertionError(f"timed out waiting for {needle!r}; tail={tail!r}")
        return bytes(self.text)

    def assert_no_iac_leak(self) -> None:
        if 0xFF in self.text:
            raise AssertionError("raw IAC byte (0xFF) leaked into terminal output")


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
            f"\n== smoke_telnet_docker[{args.flavor}]: {len(self.passed)} passed, "
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
                if event.get("method") != STATE_EVENT:
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


def send_keys(client: SidecarClient, session_id: str, sequence: int, data: bytes) -> None:
    client.send_binary(IN_CHANNEL + session_id, struct.pack(">Q", sequence) + data)


def wait_input_acks(client: SidecarClient, session_id: str, from_seq: int, to_seq: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    previous_timeout = client.timeout
    client.timeout = 0.2
    acked: set[int] = set()
    try:
        while time.monotonic() < deadline and set(range(from_seq, to_seq + 1)) - acked:
            for event in client.events:
                if event.get("method") != "telnet/terminal/inputAck":
                    continue
                params = event.get("params", {})
                if params.get("sessionId") == session_id:
                    acked.add(int(params.get("sequence", -1)))
            try:
                client._pump(None)
            except SidecarError:
                pass
    finally:
        client.timeout = previous_timeout
    missing = set(range(from_seq, to_seq + 1)) - acked
    if missing:
        raise AssertionError(f"missing telnet/terminal/inputAck for sequences {sorted(missing)}; acked={sorted(acked)}")


def start_session(client: SidecarClient, args: argparse.Namespace, extra: dict | None = None) -> str:
    try:
        started = client.request(
            "telnet/start",
            {
                "workbenchId": "smoke-telnet-docker",
                "host": args.host,
                "port": args.port,
                "cols": 100,
                "rows": 30,
                **(extra or {}),
            },
        )
    except SidecarError as error:
        skip_or_raise("telnet/start", error)
        raise
    session_id = str(started.get("sessionId") or "")
    if not session_id:
        raise AssertionError(f"telnet/start returned no sessionId: {started}")
    wait_state(client, session_id, {"connected"}, timeout=15.0)
    return session_id


def open_session_case(client: SidecarClient, collector: OutputCollector):
    def case():
        collector.drain(1.5)
        collector.assert_no_iac_leak()

    return case


def main() -> None:
    global args
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--binary", default=None, help="sidecar binary (default $DBX_PLUGIN_SIDECAR)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=2324)
    parser.add_argument("--flavor", choices=("shell", "login", "login-fail"), default="shell")
    parser.add_argument("--user", default=LOGIN_USER)
    parser.add_argument("--password", default=LOGIN_PASSWORD)
    parser.add_argument("--data-dir", default=None, help="DBX_PLUGIN_DATA_DIR override")
    args = parser.parse_args()

    binary = args.binary or os.environ.get("DBX_PLUGIN_SIDECAR") or str(
        Path(__file__).resolve().parent.parent / "backend" / "target" / "release" / "dbx-plugin-ssh"
    )

    # Environment gate: no reachable server → whole run SKIPs.
    try:
        socket.create_connection((args.host, args.port), timeout=3).close()
    except OSError as error:
        print(f"SKIP: telnet server {args.host}:{args.port} unreachable ({error}); "
              "start the protocol-matrix containers (scripts/docker/protocol-matrix/run_matrix.sh)")
        return

    started = time.monotonic()
    report = Report()
    client = SidecarClient.start(binary=binary, data_dir=args.data_dir)
    try:
        client.initialize()
        # login-fail 喂错密码（failureRegex 观测 + 预算耗尽关会话）；login 用真密码。
        password = args.password if args.flavor == "login" else "wrong-password-9x9"
        session_id = start_session(client, args, auto_login_spec(args, password))
        collector = OutputCollector(client, session_id)
        collector.drain(1.5)

        if args.flavor == "shell":
            report.run(
                "connect + IAC negotiation: banner/prompt arrives, no raw 0xFF leak",
                open_session_case(client, collector),
            )
            report.run(
                "NAWS + binary keyboard channel round-trip with inputAck",
                lambda: keyboard_roundtrip(client, collector, session_id),
            )
            report.run(
                "telnet/write JSON fallback round-trip",
                lambda: json_write_roundtrip(client, collector, session_id),
            )
            report.run(
                "telnet/resize mid-session keeps the session functional",
                lambda: resize_keeps_session(client, collector, session_id),
            )
            report.run(
                "telnet/replay redelivers frames on the out channel",
                lambda: replay_case(client, collector, session_id),
            )
            report.run(
                "telnet/close + list cleanup + write-after-close business error",
                lambda: close_case(client, collector, session_id),
            )
        else:
            report.run(
                "declarative auto-login drives busybox login to a shell"
                if args.flavor == "login"
                else "wrong password: failureRegex observed, session torn down with reason",
                lambda: auto_login_case(client, collector, session_id),
            )
            if args.flavor == "login":
                report.run(
                    "credential discipline: password bytes never echo back",
                    lambda: assert_password_not_echoed(collector),
                )
                report.run(
                    "post-login shell interaction over the binary channel (whoami)",
                    lambda: whoami_case(client, collector, session_id),
                )
                report.run(
                    "telnet/replay + close on an authenticated session",
                    lambda: replay_and_close(client, collector, session_id),
                )
    finally:
        client.close()
        stderr = client.drain_stderr()
    report.finish(started)


def auto_login_spec(args: argparse.Namespace, password: str) -> dict:
    if args.flavor == "shell":
        return {}
    return {
        "autoLogin": {
            "declarative": {
                "usernamePromptRegex": r"login: ?$",
                "username": args.user,
                "passwordPromptRegex": r"Password: ?$",
                "password": password,
                "successRegex": LOGIN_PROMPT if args.flavor == "login" else "never-success",
                "failureRegex": r"Login incorrect",
                "maxRetries": 1,
            }
        }
    }


def keyboard_roundtrip(client: SidecarClient, collector: OutputCollector, session_id: str) -> None:
    marker = b"DBX_TELNET_42_OK"
    send_keys(client, session_id, 1, b"echo DBX_TELNET_$((6*7))_OK\r")
    wait_input_acks(client, session_id, 1, 1)
    collector.wait_for(marker, timeout=15.0)
    collector.assert_no_iac_leak()


def json_write_roundtrip(client: SidecarClient, collector: OutputCollector, session_id: str) -> None:
    marker = b"DBX_TELNET_JSON_OK"
    try:
        client.request(
            "telnet/write",
            {"sessionId": session_id, "dataBase64": base64.b64encode(b"echo DBX_TELNET_JSON_OK\r").decode()},
        )
    except SidecarError as error:
        skip_or_raise("telnet/write", error)
        raise
    collector.wait_for(marker, timeout=15.0)


def resize_keeps_session(client: SidecarClient, collector: OutputCollector, session_id: str) -> None:
    try:
        client.request("telnet/resize", {"sessionId": session_id, "cols": 120, "rows": 40})
    except SidecarError as error:
        skip_or_raise("telnet/resize", error)
        raise
    send_keys(client, session_id, 2, b"echo AFTER_RESIZE_OK\r")
    collector.wait_for(b"AFTER_RESIZE_OK", timeout=15.0)
    collector.assert_no_iac_leak()


def replay_case(client: SidecarClient, collector: OutputCollector, session_id: str) -> None:
    # 回放帧在 RPC 响应抵达前后都可能出现在 binary_frames 里——以请求前的
    # 缓冲长度为基线，直接看帧数差，不依赖 drain 的文本窗口。
    baseline = len(client.binary_frames)
    try:
        summary = client.request("telnet/replay", {"sessionId": session_id, "afterSequence": 0})
    except SidecarError as error:
        skip_or_raise("telnet/replay", error)
        raise
    count = int(summary.get("frameCount") or 0)
    if count <= 0:
        raise AssertionError(f"replay summary has no frames: {summary}")
    if summary.get("complete") is not True:
        raise AssertionError(f"replay of a young session must be complete: {summary}")
    deadline = time.monotonic() + 3.0
    redelivered = []
    while time.monotonic() < deadline:
        redelivered = [
            (channel, data)
            for channel, data in client.binary_frames[baseline:]
            if channel.startswith(OUT_CHANNEL + session_id)
        ]
        if len(redelivered) >= count:
            break
        collector.drain(0.3)
    if len(redelivered) < count:
        raise AssertionError(
            f"replay summary frameCount={count} but only {len(redelivered)} frames redelivered"
        )
    for _, data in redelivered:
        if len(data) >= FRAME_HEADER and data[0] == 0xFF:
            raise AssertionError("raw IAC byte (0xFF) leaked in replayed frames")


def close_case(client: SidecarClient, collector: OutputCollector, session_id: str) -> None:
    try:
        client.request("telnet/close", {"sessionId": session_id})
    except SidecarError as error:
        skip_or_raise("telnet/close", error)
        raise
    event = wait_state(client, session_id, {"closed"}, timeout=10.0)
    # teardown 原因不苛求为空：本地 Close 与服务端随后断连的竞态可能带
    # "peer closed" 之类可读原因，只要求状态落到 closed 且清单清空。
    print(f"    close event: {event['params'].get('error')!r}")
    listing = client.request("telnet/list")
    sessions = listing.get("sessions") if isinstance(listing, dict) else listing
    if any(s.get("sessionId") == session_id for s in (sessions or [])):
        raise AssertionError("closed session still listed by telnet/list")
    try:
        client.request("telnet/write", {"sessionId": session_id, "dataBase64": "aGk="})
    except SidecarError as error:
        if "not found" not in str(error).lower() and "expired" not in str(error).lower():
            raise AssertionError(f"write-after-close raised unexpected error: {error}")
    else:
        raise AssertionError("write after close unexpectedly succeeded")


def auto_login_case(client: SidecarClient, collector: OutputCollector, session_id: str) -> None:
    if args.flavor == "login":
        collector.wait_for(LOGIN_PROMPT.encode(), timeout=30.0)
        if b"Login incorrect" in collector.text:
            raise AssertionError(f"auto-login hit failure regex unexpectedly; output={bytes(collector.text[-300:])!r}")
    else:
        deadline = time.monotonic() + 30.0
        closed: dict | None = None
        previous_timeout = client.timeout
        client.timeout = 0.2
        try:
            while time.monotonic() < deadline and closed is None:
                for event in client.events:
                    if event.get("method") != STATE_EVENT:
                        continue
                    params = event.get("params", {})
                    if params.get("sessionId") != session_id:
                        continue
                    if params.get("state") in {"closed", "error"}:
                        closed = params
                try:
                    client._pump(None)
                except SidecarError:
                    pass
        finally:
            client.timeout = previous_timeout
        collector.flush()
        if closed is None:
            raise AssertionError("wrong-password session was never torn down")
        reason = str(closed.get("error") or "")
        if not reason:
            raise AssertionError(f"teardown carries no readable reason: {closed}")
        print(f"    teardown reason: {reason!r}")
        if b"Login incorrect" not in collector.text:
            raise AssertionError("server's 'Login incorrect' never surfaced in output")


def assert_password_not_echoed(collector: OutputCollector) -> None:
    if LOGIN_PASSWORD.encode() in collector.text:
        raise AssertionError("PASSWORD BYTES APPEARED IN TERMINAL OUTPUT (echo not suppressed?)")


def whoami_case(client: SidecarClient, collector: OutputCollector, session_id: str) -> None:
    send_keys(client, session_id, 11, b"whoami\r")
    collector.wait_for(b"dbxuser", timeout=15.0)


def replay_and_close(client: SidecarClient, collector: OutputCollector, session_id: str) -> None:
    replay_case(client, collector, session_id)
    close_case(client, collector, session_id)


if __name__ == "__main__":
    main()
