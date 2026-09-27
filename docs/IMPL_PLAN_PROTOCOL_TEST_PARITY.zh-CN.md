# IMPL_PLAN — 五协议对齐特性与测试用例（Tabby / NetCatty / electerm 综合）

> 分支 `codex/ssh/tabby-protocol-parity`，2026-09-27。依据：
> `docs/TABBY_PROTOCOL_PARITY.zh-CN.md`（Tabby 33+20 条要点 + 同类工具六条建议）、
> `docs/IMPL_PLAN_NETCATTY_PARITY.zh-CN.md`（前批 NetCatty 对标口径）。
> 调研基线：Tabby `4004cc5`、electerm master、tssh master、Guacamole server HEAD；
> NetCatty 专项调研补记见 TABBY_PROTOCOL_PARITY §9。

## 0. 定位与边界（先读）

- **本插件只做 SSH/SFTP/PTY/安全运维**（manifest id `io.dbx.ssh`）。Telnet/Serial/RDP/VNC
  的*协议实现*不在本插件契约内：Telnet/Serial 历经多轮对标（NetCatty 2026-09-11、
  iShell 2026-09-12、Tabby 本轮）始终按"宿主承担或独立立项"处理；RDP/VNC 无任何
  被调研终端客户端内置，无对标样本。
- 因此本计划的"对齐"分两层：
  - **L1 测试用例对齐**（本轮全部可做）：把 Tabby/electerm/tssh/Guacamole 对
    *协议处理*的测试维度，同等覆盖到本仓库**已实现的 SSH/SFTP/PTY/传输**面。
  - **L2 特性对齐**（按批次候选，需用户/评审拍板）：只做"SSH 域内"的特性补强，
    不开新协议。
- 完成定义四件套（沿用仓库规约）：单测 + smoke 用例（未注册方法 SKIP）+
  `docs/FEATURE_PARITY.zh-CN.md` 状态更新 + 七语文案（涉 UI 时）。

## 1. 批次总览

| 批次 | 内容 | 层 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| **T0**（本轮已落地） | Tabby 测试语义对齐：zmodem 决策 7 用例 + 认证计划 3 用例 | L1 | 低 | ✅ 完成 |
| **T1** | known_hosts / 主机密钥鲁棒性矩阵扩展（tssh+electerm 维度） | L1 | 低 | ✅ 完成（TOFU/changed-key 闭环 2 用例） |
| **T2** | SFTP 传输语义边界（Guacamole 路径矩阵 + electerm 传输幂等） | L1 | 低 | ✅ 完成（后端 +2 sanitize 矩阵 + A 包 +6：transfer_paths/spool meta/路径拼接/tar 引号；前端 +1 trzsz 路径名注入 + B 包 +21：进度幂等/announce 切半/percent 钳制/路由矩阵） |
| **T3** | 认证编排纯函数化 + 顺序断言（electerm password-first / Tabby 广告驱动） | L1→L2 | **认证高风险，需评审** | 提案（评审报告已出：`docs/AUTH_DOMAIN_REVIEW.zh-CN.md`，9 项决策清单待拍板） |
| **T4** | agent 认证循环加固（上限/错误透出/指定身份） | L2 | **认证高风险，需评审** | 提案（评审定性真差距：无上限逐 key 在 MaxAuthTries 下必然烧掉前列身份；两个 smoke 不受波及；`plan_agent_identity_attempts` 纯函数化方案已写入报告） |
| **T5** | 协议广度（Telnet/Serial/RDP/VNC） | L2 | 产品决策 | 不立项建议见 §6；SFTP 文件名 gb18030 编码列为候选（§4b，需 encoding_rs 依赖讨论） |

## 7. GAP 台账（最终状态：全部闭环）

| GAP | 位置 | 内容 | 终态 |
| --- | --- | --- | --- |
| GAP-1 | `ssh.rs remote_transfer_paths` | 纯函数不收敛 `..` 段 | ✅ 已修（D 包：段级弹栈收敛 + 相对父目录弹空拒绝 + 3 用例） |
| GAP-2 | `sftp_copy.rs target_path` | 非 basename 静默取最后段名的隐式契约 | ✅ 契约固化（D 包：测试注释写明依赖上游 normalize，行为按设计保留） |
| GAP-3~7 | `terminalTrzsz.ts reduceTrzszProgress` | 进度回跳/未钳 step/重复 size 累加/num 残留/NaN 穿透 | ✅ 全部已修（D 包：单调钳制 + clamped step + sizeDeclaredFor 去重 + num 清零 + Number.isFinite 守卫；spec 同步改写为已修复语义） |

## 7b. 认证域批次（对抗评审最终决策，docs/AUTH_ADVERSARIAL_REVIEW.zh-CN.md）

| 项 | 决策 | 状态 |
| --- | --- | --- |
| #1 agent 循环加固（上限 5 + partial 即断 + 首错透出） | 实施 | ✅ A1+A2 完成（`plan_agent_identity_attempt` 纯函数 4 用例 + 运行时接线；`AgentAuthOutcome::Rejected(String)` 携带文案；smoke_login_mfa 不走 agent 路径零 diff） |
| #7 seed 语义固化测试 | 实施（仅测试） | ✅ A1 完成（koko mock `PasswordRejectedThenMfa` 形状） |
| #9 文档修订 | 实施 | ✅ B 批完成（TABBY §9 none/缓存/gb18030 表述按裁决修正） |
| gb18030 | 不引入 encoding_rs；U+FFFD 检测最小方案 | ✅ E 批完成（`entry_has_undecodable_name` + `SftpEntry.undecodable` + 前端警示图标七语；PROTOCOL 文档已同步） |
| #6 none 广告集 reconcile | 分期第二期（前置 #7 已满足） | ✅ 完成（`reconcile_advertised`/`advertised_methods` 纯函数 + 6 用例；PrivateKeyPassword 路径接 none 门，fail-open 兼容；smoke_login_mfa 13/13 真机全绿，无场景收紧） |
| #2 identity 契约字段 / #3 探活 / #4 缓存 / #5 none 探测 | 不实施 | 关单 |
| 跳板逐跳 keepalive | 不实施 | 归宿主传输层 |

## 2. T1 — known_hosts / 主机密钥测试矩阵（L1，本轮执行）

对标来源：tssh `known_hosts_test.go`（脏行隔离/标记共存/全坏文件）、electerm
`session-ssh-known-hosts.spec.js`（hashed/变更加错/端口格式/replace 闭环）、
Tabby hostKeyPromptModal（unknown vs mismatched 分流）。

现有覆盖（不重复）：`listing_survives_adversarial_known_hosts_content`、
`changed_key_message_names_the_identity`、`removal_ignores_nonstandard_marker_tokens`、
russh `check/learn_known_hosts_path` 追加语义。

新增用例（`backend/src/host_key.rs` tests + `backend/src/keys.rs` tests，纯文件 I/O）：

1. `t1a` — `[host]:port` 非默认端口条目 round-trip（写入→list→remove 计数 1）。
2. `t1b` — `@cert-authority` 与 `@revoked` 同文件共存时 list 输出 marker 各归各位，
   remove 单条不误删同 host 另一 marker 行。
3. `t1c` — 脏行（超长行/非法 base64/空行）夹在合法行之间：list 只跳脏行；
   remove 合法条目后重读文件，**合法行与脏行字节保持原样**（对齐 tssh
   "原文件不改写"断言——验证 learn/remove 路径无整文件重写副作用）。
4. `t1d` — 全坏文件：list 返回空 entries 不报错（对齐 tssh WithOnlyMalformedEntries）。
5. `t1e` — `split_host_field` 边界：`[v6-host]:2222`、`plain.host`（→22）、
   `[host]:`（无端口数字→22）、`]:`在中间的怪串。
6. `t1f` — verdict 三态映射补充：Trusted/Unknown/变更后 reject 的
   `host_key_check_responses_carry_state_and_key_identity` 已有，补
   *学习后* 二次 check 变 Trusted 的闭环（electerm "二次连接不弹窗"语义）。

验收：`cargo test --locked` 全绿；不新增运行时行为，仅测试。

## 3. T2 — SFTP 传输语义边界测试矩阵（L1，本轮执行）

对标来源：Guacamole `sftp/normalize_path.c`（相对路径拒绝/`..` 收敛/长度深度边界）、
electerm xmodem stale-ACK 幂等思想、本仓库既有 `sanitize_relative` 体系。

新增用例：

1. `t2a` — `sanitize_relative` 全矩阵：`a/b/c`、`.`、`..`、`a/../..`、空段（`a//b`）、
   尾随 `/`、反斜杠分隔（Windows 回显路径）、含 NUL 字节段（应整条拒绝）、
   仅空白段。
2. `t2b` — `safe_tree_path`：root 以 `/` 结尾与不以 `/` 结尾两种形态；
   relative 恰等于 root 自身名；深嵌套 64 层（= MAX_TREE_DEPTH）合法、65 层拒绝
   （对齐 `scan_rejects_deeper_than_limit` 的本地落盘侧）。
3. `t2c` — `remote_transfer_paths`：目标为根 `/`、目标含尾斜杠、目标为符号链接式
   `..` 路径段时临时文件/备份路径仍落在同目录（原子 rename 前提）。
4. `t2d` — 上传 spool 元数据损坏矩阵（`upload_meta_roundtrips_and_rejects_corruption`
   已有，补：字段类型错乱——size 为字符串、offset 为负数、meta 是数组）。
5. `t2e` — zmodem `validTransferOffset` 已补；补 trzsz `flattenTrzszPathName` 与
   zmodem 文件名路径段剥离对照用例（防远端 `../../name` 注入本地落盘名）。

验收：`cargo test --locked` + `pnpm --dir frontend test` 全绿；仅测试与必要的小型
纯函数导出，不改运行时行为。

## 4. T3 — 认证编排纯函数化提案（L2，需人工评审后另行开工）

对标来源：Tabby `authMethodSelection.ts`（服务器广告驱动计划器 + 7 测试）、
electerm password-first 断言、NetCatty 认证方法缓存（"第一个成功因子"）。

方案概要（**认证域，agent-flow 要求 human review，本计划只登记不动手**）：

1. 把 `ssh.rs` 密码/agent/publickey → K-I 的编排决策抽出纯函数
   `plan_next_auth_method(offered: &AuthResult, attempted: &[MethodKind],
   credentials: &AuthMaterials) -> Option<AuthStep>`；
2. 断言矩阵（对齐 Tabby 7 用例 + electerm 顺序断言）：
   - 配了 password 时首个非 none 尝试必须是 password（electerm password-first）；
   - publickey partial success 且服务器广告 K-I → 下一步 K-I；
   - full rejection 不凭空追加方法；方法耗尽返回 None；
   - isMFA + password 场景不得加载本地私钥（electerm）。
3. `authenticate_agent` 随该重构一并处理 T4（上限、首错透出、指定身份优先）。
4. NetCatty 增补项（同批评估）：认证方法缓存按 `user@host:port` 记住成功因子、
   失败即清空；none 探测作为认证计划第一步（RFC 4252）。

## 4b. T5 — SFTP 文件名编码候选（NetCatty 差距，需依赖讨论）

NetCatty 提供 `auto/utf-8/gb18030` 三档 SFTP 文件名解码（有状态 iconv，会话中可
切换）。本插件 SFTP 列表/预览目前仅 UTF-8：GBK 编码远端的文件名会乱码（终端输出
经 xterm 流式 UTF-8 尚不受影响）。若立项：引入 `encoding_rs`（Rust 侧，纯解码）
或浏览器 TextDecoder('gb18030')（前端侧，零依赖），以"列表文件名显示"为最小落点；
**先讨论再动**（新依赖触及仓库依赖红线）。

## 5. 验证顺序（每批次统一）

```
T1/T2:  cargo test --locked --manifest-path backend/Cargo.toml
        cargo fmt --check + cargo clippy -- -D warnings
        pnpm --dir frontend typecheck && pnpm --dir frontend test
T3/T4:  上述 + python3 scripts/validate_repo.py + smoke_login_mfa_test.py 真机回归
        （认证行为变更属 command_execution_changes，合流前需人工评审）
```

## 6. 协议广度立场（不立项建议，待用户确认）

- Telnet/Serial：Tabby（零测试/无自动重连/无 keepalive）与 NetCatty（原生实现 +
  设备级自动化测试，如 IAC 半包、Serial 退格序列）都有实现；本插件历经三轮对标
  均按"宿主承担"处理。若未来立项：按 TABBY_PROTOCOL_PARITY §4/§5 测试维度清单
  作为验收基线，串口必须遵守 electerm `writeRaw` 二进制通道原则，Telnet 照
  NetCatty telnetProtocol 纯函数模块形态先写解析器测试再写实现。
- RDP/VNC：Tabby/NetCatty/WindTerm/Xshell/Termius/SecureCRT 全部不做（仅
  FinalShell/Royal TS/Guacamole/electerm 有，且后两者形态不同）；真对标对象是
  Guacamole/IronRDP/noVNC，属独立产品立项，不在本插件。
- 行动项：`docs/COMPARISON.zh-CN.md` 的 RDP/Telnet"加强中"措辞改为与实际路线
  一致的表述（避免误导性预期）——随本计划落地一并微调。
