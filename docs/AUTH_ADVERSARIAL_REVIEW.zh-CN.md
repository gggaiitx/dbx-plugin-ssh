# 认证域决策清单对抗评审报告（architecture-critic，最终决策）

> 2026-09-27。对 `docs/AUTH_DOMAIN_REVIEW.zh-CN.md` 的红队攻击与裁决；
> 代码基线 d086c64 + T0-A/B/C 收口，russh 0.62.7 / russh-sftp 3.0.0，行号已实地核对。
> 本报告即最终决策记录：下表"最终决策"列为准，后续批次按 §③ 批次表执行。

## ① 执行摘要

- **翻案 1 项**：#6（none 广告集前置于方法选择）从"再讨论"改为**分期实施**，前置条件是先落 #7 的固化测试（否则改 reconcile 无安全网）。
- **修正 1 项**：#1 的"失败计数上限=6"默认值边界算错——OpenSSH MaxAuthTries 默认 6 是**含 none 探测的失败总数**，真实身份预算是 5。
- **对抗性新发现 1 项**：gb18030 议题前提是错的——russh-sftp 3.0.0 在 wire 解码层已做 `from_utf8_lossy`（`russh-sftp-3.0.0/src/buf.rs:22-23`），原始 GBK 字节在到达任何解码层之前已被 U+FFFD 摧毁，引入 encoding_rs 也救不回文件名。
- **维持 6 项**：#2/#3/#4/#5/#8/#9 结论站得住。

## ② 逐项裁决表

| # | 议题 | 最终决策 | 裁决理由（一句话） | 验收条件 |
|---|------|----------|--------------------|----------|
| 1 | agent 循环加固 | **实施，修正两处**：上限 const=5（MaxAuthTries 6 − none 探测 1）；partial+KI 命中即 break（ssh.rs:7126-7131 现状是置标志后继续烧名额） | MaxAuthTries 预算算错会恰好越界；命中 partial 后继续试身份是纯浪费名额 | 计划器纯函数单测 4 用例（满 5 停 / partial+KI 即停 / Err 停并透出首错 / PublicKey 不广告即停）+ cargo test + smoke_login_mfa 零 diff |
| 2 | agent 指定身份优先 | **不实施（本期）** | 契约扩面 YAGNI，5 次预算已封顶伤害 | —（若立项：契约评审 + 人工 sign-off） |
| 3 | agent 探活 | **不实施** | connect 失败已有独立文案（ssh.rs:7060-7072），探活是重复信息 | 现有 agent unavailable 错误用例 |
| 4 | 学习型方法缓存 | **不实施** | 静态 authentication 字段 + 逐步 method_offered 检查已封死盲试面；进程内可变状态落认证高危区不值 | — |
| 5 | none 探测 | **不实施**（已具备，ssh.rs:2456-2468），修订文档 | 代码与文档二选一必有一错，代码是对的 | 见 #9 |
| 6 | none 广告集前置 reconcile | **分期第二期实施**，前置 = #7 固化测试先合入 | 改动小，但 russh mock `Auth::reject()` 默认广告全方法（ssh.rs:9825-9827），回归面需测试网兜住；独立小 PR | reconcile 纯函数用例 + smoke_login_mfa 8 场景逐个核对 allowed_auths + koko mock 10 用例 |
| 7 | seed 语义（ssh.rs:6503 无条件 vs :6521 严格） | **不改语义、只补固化测试**（先行批次） | 改严格判定会打爆 PAM 形状 smoke（错误密码 → first_factor_accepted=false → OTP 提问无人应答，会话晾死）；残余 TOTP 风险属知情让渡且 OTP 防重放台账部分缓解 | 新增 koko mock full-rejection-seed 用例 |
| 8 | method_offered 3 单测 | **维持** | 已覆盖 Tabby 语义核心断言 | — |
| 9 | 文档修订 TABBY §9 | **实施（文档）** | "方法缓存与 none 探测未见"中 none 一半与代码不符 | 文档 diff 自查 |
| Err 即停之争 | transient vs transport-dead | **不区分，Err 即停，但必须透出首错** | 所有身份共用同一 agent handle，首错后继续无可恢复路径；russh 0.62 无可靠错误分类，整体超时已兜住悬挂 | "首错透出"单测 |
| 附加 | gb18030 + encoding_rs | **不引入 encoding_rs；最小方案**：SFTP 列表检测 U+FFFD → 条目标记"不可解码"+ 十六进制转义显示 + 提示切换远端 locale | russh-sftp 3.0.0 buf.rs:22 已 lossy 解码，+1MB 换零收益 | 后端检测函数单测（含纯 ASCII 不误报）+ 前端显示 |

## ③ 实施批次（供并行 agent 认领；A2/C 触及认证域 = human_review_required，agent 不自行合并）

| 批次 | 内容 | 文件所有权（互斥） | 依赖 |
|------|------|--------------------|------|
| A1（先行） | #7 固化测试 + #1 计划器纯函数及其单测（先测后改） | `backend/src/ssh.rs` tests mod | 无 |
| A2 | #1 运行时改造：`authenticate_agent` 接计划器（const=5、Err 停+透出、partial break） | `backend/src/ssh.rs`（7056-7144 + 2535-2553 错误文案） | A1 |
| B（可并行） | #9 文档修订 | `docs/TABBY_PROTOCOL_PARITY.zh-CN.md` 仅文档 | 无 |
| C（第二期） | #6 reconcile | `backend/src/ssh.rs` connect_authenticated 区间 | A1；独立 PR |
| D（第二期，需人工评审） | #2 identity 契约字段 | `backend/src/model.rs` + `manifest.json` + `frontend/` | #1 上线后依数据决定 |
| E | gb18030 最小方案（U+FFFD 检测 + 十六进制显示 + locale 提示） | `backend/src/ssh.rs` SFTP 列表区 + `frontend/` SFTP 视图 | 独立，可随时并行 |

**若只能改一件事**：修 #1 的上限边界（5 而非 6）加 partial 命中即 break——唯一同时影响功能正确性（长 agent 队列永远轮不到后面的身份）与安全边界（MaxAuthTries 预算浪费）的项。
