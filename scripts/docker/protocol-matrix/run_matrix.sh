#!/usr/bin/env bash
# Protocol matrix: Docker-backed real-device coverage for the nyaterm-parity
# session family (telnet / serial).
#
#   scripts/docker/protocol-matrix/run_matrix.sh               # 全部
#   scripts/docker/protocol-matrix/run_matrix.sh --keep        # 保留容器调试
#   scripts/docker/protocol-matrix/run_matrix.sh --skip-linux  # 只跑宿主机侧
#
# 拓扑：
#
#   宿主机（macOS/linux sidecar）──▶ dbx-telnetd-login :2323 (busybox login)
#                                 ──▶ dbx-telnetd-shell :2324 (busybox sh)
#   dbx-proto-linux 容器（linux sidecar + socat 虚拟串口对）
#        ├─ smoke_serial_docker.py   /tmp/dbx-vtty-a ⇄ b（真口回环 + X/Y/ZMODEM）
#        └─ smoke_telnet_docker.py ─▶ 两个 telnetd 容器（docker 网络内）
#
# Linux PTY 上 serialport-rs 走真实 termios/baud 路径（macOS 伪终端 ENOTTY
# 的空缺由此补齐）；telnetd 提供真实 IAC 协商与 login 口令流程。
# 任一 FAIL 都以非零退出；SKIP（环境缺失/方法未注册）不算失败。
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd)"

KEEP=0
SKIP_LINUX=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --skip-linux) SKIP_LINUX=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

NET="dbx-proto-net"
TELNET_IMAGE="dbx-telnetd-test"
LINUX_IMAGE="dbx-ssh-proto-linux"
TARGETS=()

cleanup() {
  [ "$KEEP" = 1 ] && { echo "== keep mode: containers/network left running"; return; }
  docker rm -f dbx-telnetd-login dbx-telnetd-shell dbx-proto-linux >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT

record() { # record <label> <exit-code>
  TARGETS+=("$1:$2")
  [ "$2" -ne 0 ] && echo "!! $1 FAILED (exit $2)"
}

echo "==> docker topology: network + telnetd containers"
docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f dbx-telnetd-login dbx-telnetd-shell dbx-proto-linux >/dev/null 2>&1 || true
# 构建上下文用本目录（Dockerfile 不 COPY 任何文件，整仓上下文纯属浪费）。
CTX="$(cd "$(dirname "$0")" && pwd)"

docker build -q -t "$TELNET_IMAGE" -f "$CTX/Dockerfile.telnetd" "$CTX" >/dev/null || {
  echo "FAIL: cannot build $TELNET_IMAGE"; exit 1; }
docker run -d --name dbx-telnetd-login --network "$NET" --network-alias dbx-telnetd-login \
  -p 2323:2323 "$TELNET_IMAGE" telnetd -F -p 2323 -l /bin/login >/dev/null || exit 1
docker run -d --name dbx-telnetd-shell --network "$NET" --network-alias dbx-telnetd-shell \
  -p 2324:2324 "$TELNET_IMAGE" telnetd -F -p 2324 -l /bin/sh >/dev/null || exit 1
for i in $(seq 1 20); do
  python3 -c "import socket;socket.create_connection(('127.0.0.1',2323),2).close()" 2>/dev/null \
    && python3 -c "import socket;socket.create_connection(('127.0.0.1',2324),2).close()" 2>/dev/null && break
  sleep 1
done
if ! python3 -c "import socket;socket.create_connection(('127.0.0.1',2323),2).close()" 2>/dev/null; then
  echo "FAIL: telnetd-login never came up"; docker logs dbx-telnetd-login | tail -5; exit 1
fi

HOST_SIDECAR="${DBX_PLUGIN_SIDECAR:-$ROOT/backend/target/release/dbx-plugin-ssh}"

if [ -x "$HOST_SIDECAR" ]; then
  echo "==> [host sidecar] telnet shell flavor (IAC/NAWS/keyboard/replay/close)"
  python3 scripts/smoke_telnet_docker.py --binary "$HOST_SIDECAR" --flavor shell --port 2324
  record "host/telnet-shell" $?

  echo "==> [host sidecar] telnet login flavor (declarative auto-login 真机层)"
  python3 scripts/smoke_telnet_docker.py --binary "$HOST_SIDECAR" --flavor login --port 2323
  record "host/telnet-login" $?

  echo "==> [host sidecar] telnet login-fail flavor (failureRegex + teardown)"
  python3 scripts/smoke_telnet_docker.py --binary "$HOST_SIDECAR" --flavor login-fail --port 2323
  record "host/telnet-login-fail" $?
else
  echo "SKIP: host sidecar binary not found at $HOST_SIDECAR (build it or set DBX_PLUGIN_SIDECAR)"
fi

if [ "$SKIP_LINUX" = 1 ]; then
  echo "== --skip-linux: Linux 层跳过"
else
  echo "==> build Linux test image (rust + socat + python3 + libudev)"
  docker build -q -t "$LINUX_IMAGE" -f "$CTX/Dockerfile.linux-test" "$CTX" >/dev/null || {
    echo "FAIL: cannot build $LINUX_IMAGE"; exit 1; }

  echo "==> start Linux sidecar container (build happens inside; volumes cache cold build)"
  docker run -d --name dbx-proto-linux --network "$NET" \
    -v "$ROOT":/src:ro \
    -v dbx-proto-cargo:/usr/local/cargo \
    -v dbx-proto-target:/target \
    "$LINUX_IMAGE" sleep infinity >/dev/null || exit 1

  echo "==> [linux sidecar] cargo build --release --locked"
  if ! docker exec -e CARGO_TARGET_DIR=/target dbx-proto-linux \
      cargo build --release --locked --manifest-path /src/backend/Cargo.toml; then
    record "linux/cargo-build" 1
  else
    echo "==> [linux sidecar] serial 真口回环（socat PTY + 设备模拟器 + X/Y/ZMODEM）"
    docker exec -e CARGO_TARGET_DIR=/target -w /tmp dbx-proto-linux \
      python3 /src/scripts/smoke_serial_docker.py --binary /target/release/dbx-plugin-ssh
    record "linux/serial-loopback" $?

    echo "==> [linux sidecar] telnet shell flavor（docker 网络内直连 telnetd 容器）"
    docker exec -e CARGO_TARGET_DIR=/target -w /tmp dbx-proto-linux \
      python3 /src/scripts/smoke_telnet_docker.py --binary /target/release/dbx-plugin-ssh \
      --host dbx-telnetd-shell --port 2324 --flavor shell
    record "linux/telnet-shell" $?

    echo "==> [linux sidecar] telnet login flavor"
    docker exec -e CARGO_TARGET_DIR=/target -w /tmp dbx-proto-linux \
      python3 /src/scripts/smoke_telnet_docker.py --binary /target/release/dbx-plugin-ssh \
      --host dbx-telnetd-login --port 2323 --flavor login
    record "linux/telnet-login" $?
  fi
fi

echo
echo "== protocol matrix summary =="
status=0
for entry in "${TARGETS[@]}"; do
  label="${entry%:*}"; code="${entry##*:}"
  if [ "$code" -eq 0 ]; then
    echo "  PASS  $label"
  else
    echo "  FAIL  $label"
    status=1
  fi
done
[ "${#TARGETS[@]}" -eq 0 ] && echo "  (no targets ran)"
exit "$status"
