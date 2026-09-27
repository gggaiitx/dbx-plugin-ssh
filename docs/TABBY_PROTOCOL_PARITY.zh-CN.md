# Tabby 五协议对标（SSH / RDP / 串口 / VNC / Telnet）+ 同类工具测试覆盖

> 分支 `codex/ssh/tabby-protocol-parity`（基于 main d086c640），2026-09-27。
> 调研基线：Eugeny/tabby master `4004cc5`（2026-09-25）。
> 结论先行：**Tabby 没有 VNC 和 RDP 实现**（VNC 仅 open issue #6918；RDP 被维护者
> 在 issue #3538 明确拒绝），**Telnet 有实现但零测试**，串口完整实现但零测试；
> Tabby 全仓库只有 3 个测试文件且全部在 SSH。本仓库 SSH 侧鲁棒性覆盖面整体
> 已等同或超过 Tabby，本轮查漏补缺聚焦测试覆盖与两处记录在案的差距。

## 1. 五协议存在性对比

| 协议 | Tabby | 本插件 | 备注 |
| --- | --- | --- | --- |
| SSH | 完整（russh 绑定 + TS 编排） | 完整（russh 原生） | 本仓库核心，详见 §3 |
| Telnet | 有（tabby-telnet，手写 IAC 协商） | 无 | 见 §4 |
| Serial | 有（tabby-serial，serialport 绑定） | 无 | 见 §5 |
| VNC | **无**（仅功能请求 #6918） | 无 | 无可对标样本 |
| RDP | **无**（维护者拒绝，#3538） | 无 | 第三方 tabby-rdp 用 IronRDP WASM |

产品决策提示：VNC/RDP 在"对标 Tabby"语境下不是差距；若未来立项，正确对标对象
是 noVNC / IronRDP 系，而非 Tabby。

## 2. Tabby 测试用例盘点（同等覆盖的基准线）

Tabby 全仓库仅 3 个测试文件（Node 内建 node:test，全部纯函数、不碰网络）：

| Tabby 测试 | 防御场景 | 本仓库对应状态 |
| --- | --- | --- |
| `tabby-ssh/test/terminalType.test.ts`（5 用例） | 持久化 TERM 脏数据（空/空白/非字符串）回落 xterm-256color | ✅ 超出：`ssh.rs:1816` 固定 `xterm-256color`，无持久化 TERM 输入面，脏值场景不存在 |
| `tabby-ssh/test/authMethodSelection.test.ts`（7 用例） | 服务器广告驱动认证降级：partial success → K-I、full rejection 不加方法、方法耗尽即停、只试广告方法 | ⚠️ 本轮补齐：`ssh.rs` `method_offered`/`auth_partial_success` 3 用例（此前纯函数零测）。本仓库实际编排（密码→K-I、agent→K-I）与 Tabby 语义一致但无直接断言 |
| `tabby-ssh/test/shellChannel.test.ts`（2 用例） | channel 打开参数组装、TERM 透传 | ✅ 超出：本仓库 592 个后端单测覆盖协议面；channel 参数为固定常量无组装逻辑 |

Telnet / Serial 包：**零测试**（Tabby 侧），无 e2e、无集成测试、无 mock server。
本仓库同等覆盖基准 = Tabby 的 SSH 测试语义 + 本仓库 smoke 家族（12 个脚本，
远超 Tabby 的"3 个纯函数文件 + CI 类型检查"质量手段）。

## 3. SSH 鲁棒性逐条映射（Tabby 33 条要点 → 本仓库）

### 已覆盖（含实现与测试）

| Tabby 要点 | 本仓库实现 |
| --- | --- |
| keepalive 间隔 + 计数上限 | `keepalive_interval_secs`（model.rs）+ russh `keepalive_max` 默认 3；另有 terminal activity keepalive（`terminal_keepalive_secs`，钳制 5–3600s，`terminal_keepalive_is_opt_in_and_clamped`） |
| 有界自动重连 + 手动断开阻断 | `connectRetry.ts`（OPEN_RETRY 2s×N 阶梯、FAST_FAIL 窗口、INACTIVE/PRECONNECT 上限）+ `sessionStatus.ts` reconnecting 状态（vitest 覆盖） |
| 主机密钥变更区分 unknown/mismatched | `host_key.rs`（`changed_key_message_names_the_identity` 等测试）+ 前端挑战协议（`hostKeyChallengeProtocol.spec.ts`） |
| 未登记入站 forwarded-tcpip 拒绝 | `ssh.rs:845-864` ConnectFailed + 日志；`forward.rs::lookup_remote_target` 有 exact/wildcard/fallback 单测 |
| partial success 补 K-I 兜底 | `ssh.rs:2503-2509`（publickey/agent 路径）+ 本轮新增 3 用例 |
| SFTP 原子上传（临时文件 + rename + 失败回滚） | `ssh.rs:7363-7528`（tmp+rename 提交、SETSTAT 失败回滚 backup、`remote_transfer_paths` 测试） |
| EOF 与 CHANNEL_CLOSE 双订阅 | `ssh.rs:2003-2007 / 7808-7811`（`Eof \| Close \| None => break`） |
| zmodem 未请求 sz 一律拒绝（deny→ZABORT） | `App.vue::handleZmodemDetection` + 本轮提取 `decideZmodemDetection` 纯函数并补 7 用例（此前零测） |
| cwd 注入单引号转义 + 防进 history | `ssh.rs:7751-7767`（HISTCONTROL/HIST_IGNORE_SPACE 恢复逻辑，`directory_tracking_scripts_are_session_local`） |
| UTF-8 边界切分 | xterm 内部流式 UTF-8 解码 + `terminalCommandMarkers.ts` `{ stream: true }` 解码 |
| 凭据不出配置文件 | 私钥只出指纹（keys.rs）、sudo profile 密钥永不回显、宿主 secret binding |
| ProxyCommand/命令注入防护 | 远端命令一律 shell 单引号转义（仓库红线） |
| 显式退出识别 | trzsz/zmodem 状态机 + 会话关闭确认（Batch3 轮） |

### 本仓库超出 Tabby 的部分（抽样）

- 认证编排强得多：TOTP 自动应答、OTP 防重放台账、keyboard-interactive 密文弹窗
  （`host.requestUserInput`）、Quick Sudo 全局档案、agent partial-success 语义。
- Tabby 无自动重连（仅手动热键 + 崩溃恢复）；本仓库有界退避自动重连。
- Tabby host key 存储是自有三元组存储，**不解析 OpenSSH known_hosts 文件**；
  本仓库 `host_key.rs` 走 known_hosts 语义且有对抗性内容测试。
- 测试手段：Tabby 3 个纯函数测试文件 + CI 类型检查；本仓库 592 后端单测 +
  621 前端 vitest + 12 个 smoke 脚本 + 宿主管线集成。

### 发现的差距（本轮行动）

1. **【已补】认证计划纯函数零测**：`method_offered`/`auth_partial_success` 此前无
   直接断言，本轮补 3 用例（对齐 Tabby authMethodSelection 语义）。
2. **【已补】zmodem 模块零测**：`terminalZmodem.ts` 此前无 spec（trzsz 有）；
   本轮提取 `decideZmodemDetection`（App.vue 内联 deny 判定 → 纯函数）+ 导出
   `validTransferOffset`（offset 越界钳制）并补 7 用例。
3. **【记录待评审，不擅自改】agent 认证循环无上限且吞错误**：`authenticate_agent`
   （ssh.rs:7056）对全部 identity 逐个尝试、`if let Ok(result)` 吞掉逐 key 错误、
   服务端 MaxAuthTries 踢线后用户只看到笼统拒绝（Tabby 同场景给出"密钥尝试过多，
   建议固定私钥"提示，且测试覆盖"只试广告方法/耗尽即停"）。属认证高风险区
   （agent-flow: command_execution_changes: human_review_required），建议后续
   专项：① 保留失败计数与首条错误文案；② 部分成功后仅在有 K-I 广告时继续。
4. **【记录待评审】agent 密钥无"指定身份优先"**：Tabby 先试配置对应 .pub 单身份
   再全量，防逐 key 试探触发服务器锁定；本仓库 agent_socket 配置无 identity 限定
   字段。同属认证区，随第 3 条一并评审。

## 4. Telnet（Tabby 有 / 本仓库无）

Tabby 协议栈（`tabby-telnet/src/session.ts`，296 行）值得借鉴的模式，若未来立项：

- **惰性协议探测**：首字节 IAC(255) 才进协议模式，否则按 raw socket（同一会话兼容
  BMC 串口重定向）——最值得抄的一条。
- **WILL/DO 白名单 + 其余对称拒绝**（防协商死循环）+ `requestedOptions` 去重
  （防应答风暴）。
- **远端/本地回显状态机**（ECHO 协商切换，防双回显）。
- **0xFF 转义中间件**（数据流中 0xFF 误判 IAC 防护）。
- **TTYPE 回 `XTERM-256COLOR`、NAWS 网络序上报**。
- 局限如实：无 keepalive、无认证、仅 UTF-8、零测试。
- 若立项，测试维度清单见调研报告：IAC 协商矩阵（WILL/DO/WONT/DONT 全组合）、
  0xFF 转义、NAWS 上报、行尾 CRLF 转换、raw-socket 探测分支、显式退出启发式。

## 5. Serial 串口（Tabby 有 / 本仓库无）

Tabby（`tabby-serial` + `tabby-terminal` 中间件层）的鲁棒性模式（若未来立项）：

- 参数全集：databits 5–8 / stopbits 1·1.5·2 / parity（mark/space 仅 Windows）/
  流控 rtscts·xon·xoff·xany / slowSend 逐字节（老设备防丢字节）。
- 枚举失败静默降级（返回空列表不崩溃）；`connected` 标志区分打开期失败与运行期错误。
- 热拔出统一收敛到 close 事件 + "Port closed" 消息；运行中 `serial.update` 热改波特率。
- 行编辑六档行尾转换（cr/lf/crlf/implicit_cr/implicit_lf/原样）+ 本地回显 + hex dump
  输出模式（二进制防渲染错乱）。
- UTF-8 边界切块中间件（读块切断多字节字符防乱码）。
- **反面教材**：无端口时 `listPorts()[0].name` 直接 TypeError——我们的实现要做空判。
- 测试维度清单：参数矩阵、流控语义、quickConnect `port@baud` 解析（非法回落 115200）、
  行尾 golden buffer、backspace 四档映射、登录脚本 expect/optional/转义。

## 6. 本轮改动清单

| 文件 | 改动 |
| --- | --- |
| `frontend/src/lib/terminalZmodem.ts` | 新增 `decideZmodemDetection` 纯函数；导出 `validTransferOffset`（补 doc 注释） |
| `frontend/src/App.vue` | `handleZmodemDetection` 改走决策纯函数（行为不变：deny 分支、roleMismatch 才报错） |
| `frontend/src/lib/terminalZmodem.spec.ts` | 新增 7 用例：检测决策 3、offset 钳制 1、sentry 接线 1、abort 中止 1、offer 拒绝跳过 1 |
| `backend/src/ssh.rs` | tests 模块新增 `auth_failure` fixture + 3 用例（method_offered 广告驱动/Success 与空集 false、auth_partial_success 三态） |
| `docs/TABBY_PROTOCOL_PARITY.zh-CN.md` | 本文档 |

验证：backend cargo test 592/592、frontend vitest 621/621、typecheck/fmt/clippy 全绿。

## 8. 同类工具测试覆盖补充调研（2026-09-27 第二轮）

对 WindTerm / electerm / tssh(trzsz-ssh) / Guacamole 及闭源商业工具的五协议测试
覆盖做了第二轮调研。横向结论：

| 项目 | SSH | Telnet | Serial | RDP | VNC | 协议层测试 |
| --- | --- | --- | --- | --- | --- | --- |
| WindTerm | ✅(vendored libssh) | ✅(自研，仅骨架开源) | ✅(未开源) | ❌ | ❌ | 自身 0 测试，仅 libssh 上游自带 |
| electerm | ✅(ssh2) | ✅ | ✅(serialport) | ✅(IronRDP WASM) | ✅(纯 TCP relay) | **同类最强**：内嵌假 SSH/Telnet 服务器 + Mock 串口 + Docker 跳板 |
| tssh | ✅(自研) | ❌ | ❌ | ❌ | ❌ | 单元级：known_hosts 鲁棒性、算法矩阵 |
| Guacamole | ✅ | ✅ | ❌ | ✅(FreeRDP) | ✅ | 纯函数级：路径归一化边界矩阵 |
| 商业三巨头 | 全有 | 全有 | 除 FinalShell 外全有 | 仅 FinalShell/Royal TS | 仅 FinalShell/Royal TS | 不可见 |

行业共性：**SSH+Telnet+Serial 是终端类产品铁三角；RDP/VNC 只出现在桌面网关类
产品（FinalShell/Guacamole/Royal TS），没有任何纯终端客户端内置**——与本插件
"宿主承担广度协议"的定位一致。**RFB 握手与 RDP X.224 的自动化测试在所有被调研
项目里都不存在**（electerm 的 RDP DER 编解码导出了函数但没写 spec）。

### 六条补齐建议的落地核对

| 建议（按投入产出排序） | 来源 | 本仓库现状 | 结论 |
| --- | --- | --- | --- |
| known_hosts 解析鲁棒性矩阵 | tssh + electerm | `host_key.rs`：8192 字符脏行截断（`MAX_KNOWN_HOSTS_LINE_LEN`）、对抗性内容测试、marker 识别；写路径走 russh `learn_known_hosts_path` 纯追加（tssh"不改写"原则天然满足） | ✅ 已覆盖 |
| SFTP 路径归一化边界矩阵 | Guacamole | `sftp_tree.rs` `sanitize_relative`（`.`/`..` 收敛）+ `safe_tree_path`（starts_with 双保险）+ traversal 单测 | ✅ 已覆盖（Guacamole 的"长度/深度双边界"维度仅适用于本地落盘路径，本插件走宿主 fileTransfer/spool 无此暴露面） |
| 内嵌假 SSH 服务器认证矩阵 | electerm | 本仓库走真容器 smoke（`smoke_login_mfa_test.py` 等 12 脚本）+ russh 内置 mock server 单测（`spawn_mock_koko`/`koko_connection`），已覆盖 K-I 多轮与 MFA | ✅ 等价覆盖（形态不同：真容器 vs 内嵌 server） |
| 认证顺序断言（password-first） | electerm | 运行时编排维度，纯函数单测无法直接断言；现有 mock server 测试覆盖了 K-I 编排顺序 | ⏸ 候选：若后续重构认证编排为纯函数计划器（Tabby authMethodSelection 形态），补顺序断言 |
| Telnet IAC 状态机测试 | electerm/WindTerm | 无 Telnet 实现 | ➖ 不适用（立项时用 §4 清单） |
| zmodem 状态机幂等（stale ACK） | electerm xmodem.spec | zmodem 上传有 abort/offer-reject/offset 钳制用例（本轮补）；stale-ACK 场景由 zmodem.js sentry 内部处理，超出纯函数层 | ✅ 等价覆盖（库层兜底） |

### electerm 值得记录的鲁棒性处理（未来立项 RDP/VNC 时）

- RDP 走 node-forge TLS 而非 Electron 内置 BoringSSL（后者对 RDP 自签证书
  KEY_USAGE_BIT_INCORRECT 过严拒绝）；start() 缓冲异步初始化窗口到达的 WS 消息防丢首包。
- Serial `writeRaw()` 绕过行尾转换保护 XMODEM 二进制通道——串口二进制协议与行模式
  共存的经典坑（若立项 Serial 必须遵守）。
- keyboard-interactive 多轮 mixed prompts（密码+OTP 同轮/跨轮）轮次序列断言——
  2FA 解析错位的最佳回归手段。

## 7. 遗留与建议排期

1. agent 认证循环上限/错误透出/指定身份优先（认证高风险，需人工评审后专项）。
2. RDP/VNC 不立项则从 COMPARISON 文档的"加强中"措辞中移除 VNC/RDP 误导性预期
   （Tabby 也没有），或明确为"对标 noVNC/IronRDP 的独立立项"。
3. 若立项 Telnet/Serial，直接采用 §4/§5 的测试维度清单作为验收基线，
   并延续本仓库"纯函数单测 + smoke"三件套模式。
4. 认证编排顺序断言（password-first）：待认证编排重构为纯函数计划器时补
   （见 §8 六条建议核对表）。

## 9. NetCatty（binaricat/Netcatty）专项调研（2026-09-27 第三轮）

仓库 `binaricat/Netcatty`（GPL-3.0，main@8568375，约 3390 文件）。**五协议结论：
SSH ✅（核心）、Telnet ✅（原生实现）、Serial ✅（serialport 13）、RDP ❌、VNC ❌**
（协议类型全集 `BuiltInHostProtocol = ssh|telnet|mosh|et|local|serial`，README 明示
"不是 shell 替代品"；广度经 `plugin:` connection-provider 契约开放给第三方）。

测试规模是所有被调研项目中最大的：**1277 个测试文件**（node:test 原生 runner），
SSH 域覆盖认证矩阵/连接池/超时/重连/主机密钥/SFTP（144 个 sftp 相关）全链路。

### NetCatty 鲁棒性要点映射（高价值子集）

| 要点 | NetCatty 做法 | 本仓库状态 |
| --- | --- | --- |
| TCP 超时与认证就绪计时分离 | readyTimeout 置 0，auth-ready 自算（默认 120s 上限 3600s），慢 2FA 不被误判超时 | ✅ 等价：`connect_timeout_secs` + 挑战期间挂起拨号超时（dial_deadline.enter_challenge） |
| 每跳独立 keepalive（含 per-host 覆盖） | 跳板链每跳 interval/countMax 独立，主机可 override（"路由器不回 keepalive"场景） | ⚠️ 部分：全局 keepalive + terminal activity keepalive 已有；跳板逐跳 keepalive 无表单面（跳板归宿主隧道，不重复实现） |
| 认证序列先 none 再降级、MFA 时 K-I 前置 | 防 MaxAuthTries 锁定；认证方法缓存"第一个成功因子"，失败即清缓存 | ✅ none 探测已具备（生产认证序列第一步即发 none，ssh.rs:2456-2468；对抗评审 #5 裁决）；⚠️ 学习型方法缓存按对抗评审 #4 裁决不实施（静态 authentication 字段 + 逐步 method_offered 检查已封死盲试面）；agent 循环加固见 docs/AUTH_ADVERSARIAL_REVIEW.zh-CN.md #1 |
| 主机密钥三态分类 | changed 仅限同 keyType 指纹不匹配；新算法按 unknown 首连提示 | ✅ 已覆盖（changed_key_message + check/learn/TOFU 闭环本轮补齐） |
| forwardOut 有界超时 | openBoundedForwardOutCallback 防 channel open 永久悬挂 | ✅ 等价：connect_timeout 包住 direct-tcpip 拨号 |
| 租约式连接池 + idle-park + denylist | 并发 open 合并、SFTP 租约保活、死链端点 denylist | ➖ 形态不同：本插件单 workbench 单会话 + 引用计数；无 idle-park 需求（宿主管会话生命周期） |
| Copy Tab 复用已认证传输 | reuseTransport + sourceSessionId | ✅ 已有：同 transport 命令会话 + "复制会话"（2026-09-24） |
| 自动重连仅对"曾连上+异常退出" | 正常 exit 不重连；按协议区分生命周期 | ✅ 等价：connectRetry 有界退避 + FAST_FAIL 窗口 |
| Telnet IAC 半包缓存 + 出站转义 + NVT 归一 | 纯函数模块 telnetProtocol（15 用例） | ➖ 无 Telnet（立项时照此清单） |
| Serial 自动登录时序兜底 | 完成事件先于 attach、用户输入即取消、65s fallback | ➖ 无 Serial |
| 输出双阈值缓冲（8ms/16KB） | 防 IPC 洪水 | ✅ 等价：terminalWriteThrottle（6 用例）+ terminalDrop 准入 |
| SFTP 文件名编码 gb18030 | auto/utf-8/gb18030 有状态 iconv 解码器 + 会话中切换 | ⚠️ 差距：本插件 SFTP 列表/预览仅 UTF-8，GBK 编码远端的文件名会乱码。登记为候选（依赖 encoding_rs，需讨论后立项） |
| SFTP 断点续传 live 测试 | 回环 SSH 大文件 resume | ✅ 已有：spool 续传 + resumable 列表 + smoke |
| ssh_config 序列化注入防护 | 分隔符注入测试 | ✅ 等价：WT-3 OpenSSH config 导入解析器（含 Include 防环） |

### NetCatty 对"测试用例同等覆盖"的启示

NetCatty 证明了纯终端方向（SSH+Telnet+Serial+Mosh+ET，明确不做 RDP/VNC）可以把
协议测试做到 1277 个文件的规模。本仓库 596 后端 + 622 前端用例与质量手段（smoke
家族 + 宿主管线集成）在 SSH/SFTP 深度上已对齐其 SSH 域核心维度（认证矩阵、主机
密钥三态、传输续传、背压、重连）。剩余缺口经对抗评审（docs/AUTH_ADVERSARIAL_REVIEW.zh-CN.md）裁决后收敛为：
① agent 循环加固（获准实施：上限 5 + partial 命中即 break + 首错透出）；
② SFTP 文件名非 UTF-8：russh-sftp 3.0.0 wire 层已 lossy 解码，encoding_rs 无效，
改做 U+FFFD 检测 + 十六进制显示 + locale 提示的最小方案；
③ 跳板逐跳 keepalive（归宿主传输层，不重复）。
