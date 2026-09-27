# 认证域差距分析报告（供人工评审）

- 评审对象：worktree `/Users/Jinpy/btroot/dbx-plugin-ssh/.worktrees/tabby-protocol-parity`
- 代码基线：`backend/src/ssh.rs`（10846 行）、`backend/src/exec.rs`、`backend/src/model.rs`
- 对标文档：`docs/TABBY_PROTOCOL_PARITY.zh-CN.md`（已记录第 3/4 条为"待评审，不擅自改"）
- 评审性质：只读分析，未修改任何文件。认证/命令执行域属 `agent-flow.yml` 声明的 human_review_required 范围。

---

## 1. agent 认证循环（`authenticate_agent`）

### 现状

`ssh.rs:7056-7144`，编排调用点 `ssh.rs:2535-2553`（`AuthenticationMethod::Agent` 分支）：

- **逐 identity 无上限**：`for identity in identities`（`ssh.rs:7110` 附近）对 agent 返回的全部身份逐个 `authenticate_publickey_with` / `authenticate_certificate_with`，没有任何数量上限、也没有"先试配置指定身份"的字段（`StoredConnection` 只有 `agent_socket`，`model.rs:120/191`，无 identity 指定）。
- **`if let Ok(result)` 吞错**（`ssh.rs:7126`）：单次身份尝试的传输层错误（会话被服务器断开、MaxAuthTries 踢线后的 disconnect）被静默跳过，循环继续对已死会话发请求，最终只会落到笼统的 `AgentAuthOutcome::Rejected` → 错误文案 `"No SSH Agent identity was accepted"`（`ssh.rs:2549`）。用户无法区分"密钥不匹配"和"服务器因尝试过多踢线"。
- **整体只有一个超时**（`ssh.rs:7120`，`connect_timeout_secs` 包住整个循环），没有逐身份失败后的提前止损。
- **agent 探活**：只有连接时 `AgentClient::connect_env/connect_uds` 失败报错（`ssh.rs:7060-7072`），没有 NetCatty 式的独立探活/重试路径。
- 已有正面语义：partial success → `NeedsKeyboardInteractive`（`ssh.rs:7128-7131`），与 koko 私钥+MFA 形状兼容，且 `ssh.rs:7876-7905` 有 3 个纯函数单测。

### 对标方做法

- **Tabby**（tabby-ssh `authMethodSelection.test.ts` 覆盖的语义）：认证方法选择是服务器广告驱动的纯函数计划器（`plan_next_auth_method` 形态）——partial success 才追加方法、full rejection 不加方法、方法耗尽即停、只试广告方法；agent 场景先试配置对应的 `.pub` 单身份，失败再全量，并给"尝试过多，建议固定私钥"的提示。
- **NetCatty**：`identitiesOnly` 严格模式（只试用户指定身份）+ agent 探活（连接前 ping agent，失败给独立错误）。

### 差距定性

**真差距（可用性/安全性双面）**：
1. 无上限逐 key 试探在 MaxAuthTries（默认 6）下必然把最前面的身份烧掉，长 agent 队列（agent 转发场景常见 10+ 身份）时后面身份永远轮不到——不只是体验问题，是功能正确性问题。
2. 吞错把"服务器踢线"伪装成"身份被拒"，误导排障方向。

"指定身份优先"目前**无配置字段**，补齐会扩契约面（`model.rs` + manifest + 前端表单），属形态差异。

### 建议方案（纯函数化）

- 抽 `plan_agent_identity_attempts(identities, offered: &AuthResult, state) -> AgentPlan` 纯函数：输入上一轮 `AuthResult`（广告集 + partial_success），输出"继续/停/转 K-I"。规则对齐 Tabby：full rejection 不消耗下一身份的广告名额？——不，逐 identity 是公钥方法内部迭代，服务器广告不变；关键是 (a) 失败计数上限（对齐 MaxAuthTries 默认 6，可配）、(b) `Err` 即停（传输错误几乎必然是踢线，继续无意义）、(c) 每轮检查 `method_offered(result, PublicKey)`，服务器不再广告 publickey 即停。
- 错误透出：收集首个 `Err` 与失败计数，最终错误文案带上 "server may have disconnected after too many auth attempts (MaxAuthTries); consider IdentitiesOnly/指定私钥"。
- 可选第二期：`agent_identity`（指纹或公钥注释匹配）契约字段 + agent 探活，随表单/manifest 一并评审。
- 注意 Windows Pageant 分支与 `#[cfg(unix)]` 的差异要在纯函数化时保持。

### 风险与回归面

- 现有单测：`ssh.rs:7876-7905`（method_offered/auth_partial_success 3 用例）不受影响；新增计划器用例应放同区。
- `smoke_login_mfa_test.py`：8 个场景全部走 password/KI 形状，**不含 agent 路径**，不受影响。
- `smoke_sudo_otp_test.py`：走 password+OTP shim，**不含 agent 路径**，不受影响。
- 真容器 smoke `smoke_test.py` 若以 agent 方式连接（需确认 CI 环境 agent 可用性），错误文案变化可能影响断言。
- 行为变化点：`Err` 即停会让"某个身份编码异常但后面有可用身份"的极端场景从自动跳过变为报错——需评审接受（russh agent 协议错误通常是致命的，可接受）。

---

## 2. 认证方法缓存（NetCatty "第一个成功因子"语义）

### 现状

- **无跨会话缓存**：全 `ssh.rs` 搜索无按 `user@host:port` 记录"上次成功方法"的结构；重连（断线重连路径）每次从 `connect_authenticated` 的固定编排重新走起。
- **`StoredConnection.authentication`（`model.rs:111`）**：是**用户配置的静态方法选择器**（password / private-key / private-key-password / agent / none），不是学习型缓存。`AuthenticationMethod::from_connection`（`model.rs:368`）在缺密码/缺密钥时有契约校验降级（`model.rs:515-548` 的报错分支），即它是"声明式意图"，没有"失败即清空、回退重学"语义。
- **部分等价判定**：对"已存储的连接"而言，静态声明 `authentication` 达到了与缓存近似的**前置效果**（跳过盲试其他方法），因为编排（`ssh.rs:2512-2553`）按该字段直接走单一主路径，密码方法内部还有 password→KI 的广告驱动降级（`authenticate_password_or_interactive`，`ssh.rs:6483-6535`）。差距在于：(a) 临时/inline 连接与断线重连没有这个前置；(b) 服务器配置变更（如管理员关掉 password）时没有学习/失效机制，只能靠每次的广告检查兜底。

### 对标方做法

NetCatty 按 `user@host:port` 缓存上次成功方法并在下次认证前置（第一个成功因子），失败即清空缓存回退到完整序列。

### 差距定性

**形态不同的部分等价**。本仓库的"前置"由静态契约字段承担，且每次尝试仍受服务器广告约束（`method_offered` 前置检查 `ssh.rs:6490/6519`），盲试面已经很小。补学习型缓存的边际收益主要是：`AuthenticationMethod::PrivateKeyPassword`（密钥失败→password→KI，`ssh.rs:2522-2530`）这类多步路径省一次注定失败的尝试，以及 inline MCP 拨号路径。成本是新增持久化状态 + 失效逻辑，落在认证高危区。

### 建议方案

若做，建议进程内 `Mutex<HashMap<String /*user@host:port*/, MethodKind>>`（不落盘、不存凭据），在 `connect_authenticated` 成功后写入、认证序列开始前读取并前置；失败即 remove。纯函数化核心是 `next_method_after(cache_hit, advertised, partial) -> Option<MethodKind>`。建议**排低优先级**——现有静态字段+广告检查已覆盖大部分收益。

### 风险与回归面

- 若实现，重连路径（`smoke_terminal_keepalive_test.py`、断线重连 smoke）会命中缓存路径，需加"缓存命中/清空"两向用例。
- `smoke_login_mfa_test.py`/`smoke_sudo_otp_test.py` 每场景新建连接，缓存为空不影响。
- 不做则维持现状，无回归面。

---

## 3. none 探测

### 现状

**生产路径已具备**，`ssh.rs:2456-2468`（`connect_authenticated`）：

```rust
let none = tokio::time::timeout(timeout, session.authenticate_none(&connection.username)).await ...;
if none.success() { return Ok(session); }
if connection.authentication == AuthenticationMethod::None {
    return Err("SSH server rejected unauthenticated access".to_string());
}
```

即：每次认证序列第一步就发 RFC 4252 none 请求，成功即免认证登录；失败后按配置方法走正式序列。**不是盲试**。

- 测试里的 `auth_none`（`ssh.rs:9702-9704`）是 russh **mock server**（`MockKokoSession`）的方法，固定 `Auth::reject()`，用来模拟"需要真实认证"的服务器；它不是生产代码。调研文档 `TABBY_PROTOCOL_PARITY.zh-CN.md:190` 写"方法缓存与 none 探测未见"，**none 探测这一半与代码现状不符**（可能基于旧版代码或表述不精确），建议评审后修订文档。

### 对标方做法

NetCatty：认证序列第一步 none 探测读取服务器广告（`remaining_methods`），据此排后续方法顺序。

### 差距定性

**形态不同的等价（广告读取上略有差距）**：本仓库做了 none 探测（防 MaxAuthTries 白耗），但**没有消费探测结果里的广告集**——`none` 的 `AuthResult::Failure { remaining_methods, .. }` 被丢弃，后续方法顺序只由静态 `authentication` 字段 + 逐层 `method_offered` 检查驱动。两者在"不会盲试未广告方法"这一安全性质上等价（每步都检查广告），差距仅是"多一次注定失败的尝试"（如配置 password 但服务器只广告 KI 时，会先试 password 一次再降级，消耗 1 个 MaxAuthTries 名额）。

### 建议方案

把 `none` 的 `remaining_methods` 传入后续编排（即 `authenticate_password_or_interactive` 的 `offered` 从"上一个方法的结果"扩展为"none 探测结果或上一方法结果"），配置方法不被广告时直接跳到 KI。改动集中在 `connect_authenticated` 的 match 前，加一个纯函数 `reconcile(configured, none_offered) -> Plan`。属小改动，但仍在认证域，需人工评审。

### 风险与回归面

- `ssh.rs:7876-7905` 纯函数测试可扩 `reconcile` 用例。
- `smoke_login_mfa_test.py` 的 `KI_MFA_ONLY`/`KI_PASSWORD_THEN_MFA` 场景：mock 服务器广告集含 KI；若 password 配置且服务器不广告 password，新逻辑会跳过 password 直接 KI——`PASSWORD_THEN_MFA` 场景（服务器广告 password,publickey,keyboard-interactive，`smoke_login_mfa_test.py:183`）行为不变，但**需逐场景核对 allowed_auths 广告集**，这是主要回归面。
- `smoke_sudo_otp_test.py`：真实容器 sshd 广告 publickey,password；该 smoke 走 password，无影响。
- `spawn_mock_koko` 系列单测（`ssh.rs:9913-10183`，约 10 个）走 password→partial→KI 编排，`MockKokoSession::auth_none` 固定 reject 且后续 `auth_password` 正常，编排前置检查不变则结果不变；若 `reconcile` 依据 none 广告跳过 password，需确认 mock 的 none reject 是否携带正确广告集——russh 服务端 `Auth::reject()` 默认广告全部方法，预计无影响，但要加用例固化。

---

## 4. partial success 语义边界与密码重复提交面

### 现状

- `method_offered`（`ssh.rs:6454-6461`）：仅当 `AuthResult::Failure { remaining_methods }` 包含该方法时为真；Success/其他恒 false。
- `auth_partial_success`（`ssh.rs:6470-6480`）：仅服务器置 `partial_success` 位时为真。
- `authenticate_password_or_interactive`（`ssh.rs:6483-6535`）：
  - password 被广告 → `try_password` 一次（`ssh.rs:6537-6550`）；失败且广告 KI → 转 KI 并**无条件传 `first_factor_accepted=true`**（`ssh.rs:6503-6512`），注释明说"PAM 栈甚至不置该位"。
  - password 不被广告、KI 被广告 → KI，`first_factor_accepted = auth_partial_success(offered)`（`ssh.rs:6519-6529`），此处是严格判定。
- KI 门控：`exec.rs:777-799` `can_respond_to_prompt`——`password_then_otp` 模式下 OTP 应答要求 `password_answered`；`KeyboardInteractiveState::first_factor_accepted()`（`exec.rs:1430-1437`）把 `password_answered` 置真。

### 密码重复提交的具体分支分析

**字面意义的"密码发两次给认证请求"不存在**：password 方法只调一次 `authenticate_password`；KI 轮次里 Password 类提示被 `can_respond_to_prompt(Password, password_answered=true)` 门控为**不应答**（`exec.rs:784-788`，防第二行密码错位）。

**真正的语义边界（值得评审知晓）**：`ssh.rs:6503-6512` 的 KI 降级**不要求** `auth_partial_success`——只要服务器仍广告 KI，即使密码被**完整拒绝**（非 partial，如密码错误且 PAM 栈不置位），KI 仍以 `first_factor_accepted=true` 起步。后果：`password_then_otp` 模式下，密码错误的连接仍会自动应答 OTP 提问（把 TOTP 码发给一个第一因子未通过的服务器）。这与 `ssh.rs:6521`（KI-only 路径严格用 `auth_partial_success`）不一致，是注释里"password path seeds itself"的刻意让渡（PAM 栈密码错也问 OTP 的形状依赖它），但意味着：错误密码 + OTP 配置时，TOTP 码可能被消耗/提交到未通过第一因子的会话。现有 `keyboard_interactive_answers`（`exec.rs:1463+`）的 Combined 降级与 OTP 防重放台账部分缓解了误提交后果。

### 差距定性

**有意让渡 + 一处不一致**。让渡本身服务于 PAM 现实形状（有 smoke 覆盖），不建议直接改语义；但 `ssh.rs:6503` 的无条件 seed 与 `ssh.rs:6521` 的严格判定并存，缺一条注释外的行为测试固化"完整拒绝也 seed"的契约。

### 建议方案

- 不改运行时行为；补纯函数/集成测试固化：password full-rejection + KI advertised → KI 以 seed=true 起步（`smoke_login_mfa_test.py` 的 `KI_PASSWORD_THEN_MFA` 形状部分覆盖，建议在 Rust mock 单测补对应 Shape）。
- 若评审认为"错误密码不应消耗 TOTP"更安全，方案是把 `ssh.rs:6503` 改为 `auth_partial_success(&result) || /* PAM 形状开关 */`，用配置/启发式区分——属行为变更，须人工决策，且会触碰 `smoke_login_mfa_test.py` 的 PAM 形状场景。

### 风险与回归面

- 直接相关：`smoke_login_mfa_test.py`（8 场景全走 password/KI 编排）、`smoke_sudo_otp_test.py`（OTP 防重放台账）。任何 seed 语义改动都会波及。
- Rust mock 单测 `ssh.rs:9913-10183` 约 10 个 koko 形状用例同样踩在这条路径上。

---

## 5. 人工评审决策清单

| # | 议题 | 建议 | 一句话理由 |
|---|------|------|-----------|
| 1 | agent 循环：失败计数上限 + `Err` 即停 + 错误透出（MaxAuthTries 提示） | **改**（专项） | 无上限逐 key 试探是功能正确性问题（MaxAuthTries 下后续身份必然失效），且吞错误导排障；纯函数计划器可测试。 |
| 2 | agent 指定身份优先（`identitiesOnly`/identity 字段） | **再讨论** | 需扩连接契约（model/manifest/前端表单），收益依赖用户 agent 队列长度；可与 #1 分期。 |
| 3 | agent 探活（连接前 ping） | **不改** | 现有 connect 失败已给出独立错误文案，探活边际价值低。 |
| 4 | 认证方法学习型缓存（NetCatty 式 user@host:port） | **不改**（暂缓） | 静态 `authentication` 字段 + 每步广告检查已覆盖主要盲试面；学习缓存新增持久化状态落在认证高危区，收益不成比例。 |
| 5 | none 探测 | **不改** | 生产路径已具备（`ssh.rs:2456-2468`）；调研文档 190 行"未见"表述过时，修订文档即可。 |
| 6 | none 探测广告集前置于方法选择（`reconcile`） | **再讨论** | 小改动可省一次注定失败的尝试，但要逐场景核对 mock/真容器广告集，回归面跨 smoke_login_mfa 与 koko 单测；单独小 PR 更稳。 |
| 7 | partial success：password full-rejection 仍 seed KI（`ssh.rs:6503`） | **不改，补测试** | 是服务 PAM 形状的有意让渡，改动会破坏既有 MFA smoke；当前缺口只是缺一条固化该契约的测试。 |
| 8 | `method_offered`/`auth_partial_success` 已有 3 单测 | **不改** | Tabby authMethodSelection 语义已对齐并有断言（调研文档 30 行确认）。 |
| 9 | 文档修订：`TABBY_PROTOCOL_PARITY.zh-CN.md:190` none 探测表述 | **改**（文档） | 与代码现状不符，避免后续评审被误导。 |

---
报告生成：2026-09-27，只读评审，未改动 worktree 任何文件。
