# 协议矩阵 Docker 真机层（telnet / serial）

`run_matrix.sh` 用 Docker 补齐新协议会话（nyaterm parity：Telnet / Serial /
X-Y-ZMODEM）的真机式端到端覆盖：

- **Telnet**：对真实 telnetd 服务器（busybox telnetd，真实 IAC 协商
  DO ECHO / DO NAWS / WILL ECHO / WILL SGA）验证连接、NAWS、键入二进制
  通道、JSON 兜底、声明式自动登录（真 login 口令流程）、失败正则观测、
  预算耗尽关会话、replay、close。宿主机（macOS/linux）与 Linux 容器内
  的 sidecar 都各跑一遍（跨平台传输层语义一致）。
- **Serial**：serialport-rs 在 macOS 伪终端上 ENOTTY（`smoke_serial_upload.py`
  的 PTY 回环层会 SKIP）；Linux PTY 走真实 termios/baud 路径，容器内
  socat 组一条虚拟空解调线，Python 设备模拟器扮演路由器控制台（banner、
  行回显、`show version`/`ati`、`rx` 进 XMODEM 接收），对 Linux sidecar
  跑全链路：枚举、8N1 起、banner、键入、JSON 写、严格线参数校验、
  XMODEM 全传（'C' 邀请 → CRC 块 → EOT 先 NAK 再 ACK 双确认 → 字节级
  比对）、ZMODEM 起传（ZRQINIT）+ 取消（ZDLE×5+BS×5 → failed）、
  replay、close。

## 拓扑

```
宿主机 sidecar ──▶ dbx-telnetd-login :2323（busybox login，auto-login 真机层）
              ──▶ dbx-telnetd-shell :2324（busybox sh，IAC/NAWS/键入/回放）
dbx-proto-linux 容器（linux sidecar，rust 镜像 + socat + python3）
    ├─ smoke_serial_docker.py  /tmp/dbx-vtty-a ⇄ /tmp/dbx-vtty-b（虚拟串口）
    └─ smoke_telnet_docker.py ─▶ docker 网络内两个 telnetd 容器
```

## 用法

```bash
scripts/docker/protocol-matrix/run_matrix.sh               # 全部
scripts/docker/protocol-matrix/run_matrix.sh --skip-linux  # 只跑宿主机侧 telnet
scripts/docker/protocol-matrix/run_matrix.sh --keep        # 失败后保留容器排查
```

- 宿主机侧默认用 `backend/target/release/dbx-plugin-ssh`，可用
  `DBX_PLUGIN_SIDECAR` 覆盖。
- Linux 层在 `Dockerfile.linux-test` 容器内 `cargo build --release --locked`，
  缓存走命名卷 `dbx-proto-cargo` / `dbx-proto-target`（冷构建一次后增量）。
- 任一 FAIL 都以非零退出；SKIP（环境缺失 / 方法未注册）不算失败。
- 冒烟脚本也可单独跑（telnetd 容器起着时）：

```bash
python3 scripts/smoke_telnet_docker.py --flavor shell --port 2324
python3 scripts/smoke_telnet_docker.py --flavor login --port 2323
python3 scripts/smoke_telnet_docker.py --flavor login-fail --port 2323
```

## Windows 侧

本矩阵跑不了 Windows 容器（macOS Docker 只能跑 Linux 容器）。Windows
覆盖走 CI `windows-regression` job（windows-2022 原生 `cargo test` +
release 构建 + `smoke_mcp.py`）与 `Package candidate (windows-x64)` 打包
job；真机 COM 口与 DBX 安装链路验收按仓库约定属人工门（`install.cmd` +
双冒烟，见 `AGENTS.md` / skill）。
