//! Server-side copy/move (`sftp/copy`, `sftp/move`), mirroring tiny-rdm's
//! server-internal copy & paste: sources are copied/moved *into* `toDir`
//! under their own name via the session's shell (`cp -a --` / `mv -f --`).
//! Moves inside one directory first try an SFTP rename and fall back to the
//! shell. No sudo variant (tiny-rdm has none either).

use std::sync::Arc;

use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use crate::exec;
use crate::model::normalize_remote_path;
use crate::ssh::{SshClient, SshRuntime};

/// Remote `cp`/`mv` commands run with this budget; recursive directory
/// copies can legitimately take a while.
const REMOTE_COPY_TIMEOUT_SECS: u64 = 300;

/// Whether an operation copies or moves its sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyOp {
    Copy,
    Move,
}

impl CopyOp {
    fn label(self) -> &'static str {
        match self {
            CopyOp::Copy => "copy",
            CopyOp::Move => "move",
        }
    }
}

/// Parsed `sftp/copy` / `sftp/move` request:
/// `{ connectionId, from: string|string[], toDir: string, overwrite?: bool }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMoveRequest {
    pub from: Vec<String>,
    pub to_dir: String,
    pub overwrite: bool,
}

/// Per-source outcome of a copy/move batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemOutcome {
    pub from: String,
    pub to: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// Batch outcome: `{ success, results: [{ from, to, ok, error? }] }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyMoveOutcome {
    pub success: bool,
    pub results: Vec<ItemOutcome>,
}

impl CopyMoveOutcome {
    /// Contract shape consumed by the SFTP panel: `error` is present only
    /// on failed items.
    pub fn into_json(self) -> Value {
        json!({
            "success": self.success,
            "results": self.results.iter().map(ItemOutcome::to_json).collect::<Vec<_>>(),
        })
    }
}

impl ItemOutcome {
    fn to_json(&self) -> Value {
        let mut item = json!({ "from": self.from, "to": self.to, "ok": self.ok });
        if let Some(error) = &self.error {
            item["error"] = json!(error);
        }
        item
    }

    fn ok(from: &str, to: &str) -> Self {
        Self {
            from: from.to_string(),
            to: to.to_string(),
            ok: true,
            error: None,
        }
    }

    fn failed(from: &str, to: &str, error: String) -> Self {
        Self {
            from: from.to_string(),
            to: to.to_string(),
            ok: false,
            error: Some(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Request parsing (pure)
// ---------------------------------------------------------------------------

/// Parses the copy/move parameters shared by the plugin RPC and the MCP tool.
pub fn parse_request(params: &Value) -> Result<CopyMoveRequest, String> {
    let from_value = params.get("from").ok_or("Missing from")?;
    let raw_sources = match from_value {
        Value::String(single) => vec![single.clone()],
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "from must be a string or an array of strings".to_string())
            })
            .collect::<Result<Vec<String>, String>>()?,
        _ => return Err("from must be a string or an array of strings".to_string()),
    };
    let mut from = Vec::with_capacity(raw_sources.len());
    for source in raw_sources {
        let trimmed = source.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = normalize_remote_path(trimmed)?;
        if normalized == "/" {
            return Err("Refusing to copy or move the filesystem root".to_string());
        }
        from.push(normalized);
    }
    if from.is_empty() {
        return Err("At least one source path is required".to_string());
    }
    let to_dir = params
        .get("toDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Missing toDir")?;
    let to_dir = normalize_remote_path(to_dir)?;
    // Boolean tolerance lives with the MCP argument helpers: a string
    // "true" must not silently read as overwrite=false.
    let overwrite = crate::mcp::arg_bool(params, "overwrite")?.unwrap_or(false);
    Ok(CopyMoveRequest {
        from,
        to_dir,
        overwrite,
    })
}

/// Target path for a source copied into `to_dir`: the source's own name
/// underneath the destination directory.
pub fn target_path(to_dir: &str, from: &str) -> String {
    let name = from
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    if name.is_empty() {
        return format!("{}/copy", to_dir.trim_end_matches('/'));
    }
    format!("{}/{}", to_dir.trim_end_matches('/'), name)
}

/// True when a move can take the SFTP-rename fast path: source and
/// destination directory are the same.
pub fn same_directory(from: &str, to_dir: &str) -> bool {
    let parent = from
        .trim_end_matches('/')
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let parent = if parent.is_empty() { "/" } else { parent };
    let dir = to_dir.trim_end_matches('/');
    let dir = if dir.is_empty() { "/" } else { dir };
    parent == dir
}

// ---------------------------------------------------------------------------
// Command builders (pure)
// ---------------------------------------------------------------------------

/// `cp -a -- <src> <toDir/name>` — archive mode keeps permissions, timestamps
/// and copies directories recursively.
pub fn build_copy_command(source: &str, target: &str) -> String {
    format!(
        "cp -a -- {} {}",
        exec::shell_quote(source),
        exec::shell_quote(target)
    )
}

/// `mv -f -- <src> <toDir/name>`.
pub fn build_move_command(source: &str, target: &str) -> String {
    format!(
        "mv -f -- {} {}",
        exec::shell_quote(source),
        exec::shell_quote(target)
    )
}

/// One-shot existence probe for every target: echoes the index of each path
/// that already exists; the trailing `true` keeps the overall exit status 0.
pub fn build_exists_probe_command(targets: &[String]) -> String {
    let mut command = String::new();
    for (index, target) in targets.iter().enumerate() {
        if index > 0 {
            command.push_str("; ");
        }
        command.push_str(&format!(
            "test -e {} && echo {}",
            exec::shell_quote(target),
            index
        ));
    }
    command.push_str("; true");
    command
}

/// Reduces probe output to a per-index "already exists" table.
pub fn existing_targets(output: &str, count: usize) -> Vec<bool> {
    let mut existing = vec![false; count];
    for line in output.lines() {
        if let Ok(index) = line.trim().parse::<usize>() {
            if index < count {
                existing[index] = true;
            }
        }
    }
    existing
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// How remote commands are issued for one copy/move batch.
enum CopyExecutor<'a> {
    /// Plugin RPC path: routed through [`SshRuntime::exec`] so session
    /// lookup, timeouts and exec bookkeeping stay in one place.
    Session(&'a SshRuntime, &'a str),
    /// MCP pooled connection: direct handle plus an optional SFTP channel.
    Headless(&'a Handle<SshClient>, Option<Arc<AsyncMutex<SftpSession>>>),
}

impl CopyExecutor<'_> {
    async fn exec(&self, command: &str) -> Result<exec::ExecOutcome, String> {
        match self {
            CopyExecutor::Session(runtime, session_id) => {
                let value = runtime
                    .exec(
                        session_id,
                        None,
                        command,
                        false,
                        Some(REMOTE_COPY_TIMEOUT_SECS),
                    )
                    .await?;
                Ok(exec::ExecOutcome {
                    output: value
                        .get("output")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    exit_code: value.get("exitCode").and_then(Value::as_i64).unwrap_or(-1) as i32,
                })
            }
            CopyExecutor::Headless(handle, _) => {
                // Internal copy plumbing: env-free so output parsing stays
                // independent of the connection's setEnv overrides.
                exec::exec_plain(
                    handle,
                    command,
                    std::time::Duration::from_secs(REMOTE_COPY_TIMEOUT_SECS),
                    &[],
                )
                .await
            }
        }
    }

    async fn sftp(&self) -> Option<Arc<AsyncMutex<SftpSession>>> {
        match self {
            CopyExecutor::Session(runtime, session_id) => runtime.sftp(session_id).await.ok(),
            CopyExecutor::Headless(_, sftp) => sftp.clone(),
        }
    }
}

/// `sftp/copy` / `sftp/move` entry for the plugin RPC. The session is
/// resolved by the caller (connection id or session id).
pub async fn run(
    runtime: &SshRuntime,
    session_id: &str,
    op: CopyOp,
    params: &Value,
) -> Result<Value, String> {
    runtime.ensure_writable(session_id).await?;
    let request = parse_request(params)?;
    let outcome = execute_with(CopyExecutor::Session(runtime, session_id), op, &request).await;
    Ok(outcome.into_json())
}

/// `sftp_copy` / `sftp_move` MCP tool entry over a pooled headless
/// connection. `sftp` enables the SFTP-rename fast path for moves.
pub async fn execute(
    handle: &Handle<SshClient>,
    sftp: Option<Arc<AsyncMutex<SftpSession>>>,
    op: CopyOp,
    request: &CopyMoveRequest,
) -> CopyMoveOutcome {
    execute_with(CopyExecutor::Headless(handle, sftp), op, request).await
}

async fn execute_with(
    executor: CopyExecutor<'_>,
    op: CopyOp,
    request: &CopyMoveRequest,
) -> CopyMoveOutcome {
    let targets: Vec<String> = request
        .from
        .iter()
        .map(|source| target_path(&request.to_dir, source))
        .collect();

    // With overwrite disabled, block every item whose target already exists
    // before running anything (one round trip for the whole batch).
    let mut blocked = vec![false; targets.len()];
    if !request.overwrite {
        match executor.exec(&build_exists_probe_command(&targets)).await {
            Ok(outcome) if outcome.exit_code == 0 => {
                blocked = existing_targets(&outcome.output, targets.len());
            }
            Ok(outcome) => {
                eprintln!(
                    "[ssh] sftp {} existence probe failed (exit {}): {}; continuing with per-item attempts",
                    op.label(),
                    outcome.exit_code,
                    outcome.output.trim()
                );
            }
            Err(error) => {
                eprintln!(
                    "[ssh] sftp {} existence probe failed: {error}; continuing with per-item attempts",
                    op.label()
                );
            }
        }
    }

    // Only moves use the SFTP-rename fast path; the channel is opened lazily
    // and its absence simply disables the optimization.
    let sftp = match op {
        CopyOp::Move => executor.sftp().await,
        CopyOp::Copy => None,
    };

    let mut results = Vec::with_capacity(request.from.len());
    for (index, source) in request.from.iter().enumerate() {
        let target = &targets[index];
        if blocked[index] {
            results.push(ItemOutcome::failed(
                source,
                target,
                format!("target already exists: {target} (pass overwrite to replace)"),
            ));
            continue;
        }

        // Fast path: same-directory moves are a plain rename.
        if op == CopyOp::Move && same_directory(source, &request.to_dir) {
            if let Some(sftp) = &sftp {
                match sftp
                    .lock()
                    .await
                    .rename(source.clone(), target.clone())
                    .await
                {
                    Ok(()) => {
                        results.push(ItemOutcome::ok(source, target));
                        continue;
                    }
                    Err(error) => {
                        eprintln!(
                            "[ssh] sftp rename fast path failed for {source} -> {target}: {error}; falling back to shell mv"
                        );
                    }
                }
            }
        }

        let command = match op {
            CopyOp::Copy => build_copy_command(source, target),
            CopyOp::Move => build_move_command(source, target),
        };
        match executor.exec(&command).await {
            Ok(outcome) if outcome.exit_code == 0 => {
                results.push(ItemOutcome::ok(source, target));
            }
            Ok(outcome) => {
                let detail = outcome.output.trim();
                results.push(ItemOutcome::failed(
                    source,
                    target,
                    format!(
                        "{} failed (exit {}): {detail}",
                        op.label(),
                        outcome.exit_code
                    ),
                ));
            }
            Err(error) => {
                results.push(ItemOutcome::failed(
                    source,
                    target,
                    format!("{} failed: {error}", op.label()),
                ));
            }
        }
    }

    CopyMoveOutcome {
        success: results.iter().all(|item| item.ok),
        results,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_request_accepts_single_string_and_array() {
        let single = parse_request(&json!({
            "connectionId": "c1",
            "from": "/var/log/app.log",
            "toDir": "/tmp",
        }))
        .unwrap();
        assert_eq!(
            single,
            CopyMoveRequest {
                from: vec!["/var/log/app.log".to_string()],
                to_dir: "/tmp".to_string(),
                overwrite: false,
            }
        );

        let batch = parse_request(&json!({
            "connectionId": "c1",
            "from": ["/a/b.txt", " /c/d.txt ", "", "/x/../e"],
            "toDir": "/dst/",
            "overwrite": true,
        }))
        .unwrap();
        assert_eq!(batch.from, vec!["/a/b.txt", "/c/d.txt", "/e"]);
        assert_eq!(batch.to_dir, "/dst");
        assert!(batch.overwrite);
    }

    #[test]
    fn parse_request_rejects_invalid_params() {
        let error = parse_request(&json!({ "from": "/a" })).unwrap_err();
        assert_eq!(error, "Missing toDir");

        let error = parse_request(&json!({ "toDir": "/tmp" })).unwrap_err();
        assert_eq!(error, "Missing from");

        let error = parse_request(&json!({ "from": ["/a", 3], "toDir": "/tmp" })).unwrap_err();
        assert!(error.contains("array of strings"), "{error}");

        let error = parse_request(&json!({ "from": [], "toDir": "/tmp" })).unwrap_err();
        assert!(error.contains("At least one source"), "{error}");

        let error = parse_request(&json!({ "from": "  ", "toDir": "/tmp" })).unwrap_err();
        assert!(error.contains("At least one source"), "{error}");

        let error = parse_request(&json!({ "from": "/", "toDir": "/tmp" })).unwrap_err();
        assert!(error.contains("filesystem root"), "{error}");
    }

    #[test]
    fn copy_and_move_commands_quote_every_argument() {
        assert_eq!(
            build_copy_command("/var/my app.log", "/tmp/x"),
            "cp -a -- '/var/my app.log' '/tmp/x'"
        );
        assert_eq!(
            build_move_command("/var/it's", "/tmp"),
            r"mv -f -- '/var/it'\''s' '/tmp'"
        );
    }

    #[test]
    fn target_paths_keep_the_source_name() {
        assert_eq!(target_path("/tmp", "/var/log/app.log"), "/tmp/app.log");
        assert_eq!(target_path("/tmp/", "/var/log"), "/tmp/log");
        assert_eq!(target_path("/tmp", "/opt"), "/tmp/opt");
    }

    /// 目标目录形态边界（T2 补充，对标 electerm 传输幂等语义）：
    /// `parse_request` 先把 toDir 过 `normalize_remote_path`（收敛 `..`、
    /// 折叠 `//`），所以到达 `target_path` 的 toDir 已是规范化绝对路径；
    /// 本矩阵单独压 `target_path` 纯函数本身，保证调用方（copy/move 批处理）
    /// 无论传入什么形态都拿到**单个斜杠分隔**的绝对目标——拼接结果出现
    /// 空段或双斜杠会让 `cp/mv` 与探测命令语义漂移。
    #[test]
    fn target_path_handles_root_and_trailing_slashes() {
        // to_dir 为根 `/`：trim_end_matches('/') 后是空串，结果以 "/" 开头
        // 而不是变成相对路径（空串拼接会产出 "name"，copy 会落到远端 CWD）。
        assert_eq!(target_path("/", "/var/log/app.log"), "/app.log");
        // 多个尾斜杠：全部收敛，不产生 "tmp//name"。
        assert_eq!(target_path("/tmp///", "/var/log/app.log"), "/tmp/app.log");
        // 根带多尾斜杠（normalize 后不会出现，防御纯函数自身）。
        assert_eq!(target_path("///", "/etc/hosts"), "/hosts");
    }

    /// `from` 的名字段本身带 `/`（调用方没先取 basename）时，`target_path`
    /// 取的是**最后一段**名字，绝不会把整条 from 拼进目标——这是天然的
    /// 路径穿越防线：`/var/log/../etc/passwd` 只会落到 `<toDir>/passwd`，
    /// 不会逃出 toDir。但反过来说，若上游未做 normalize，`a/b` 这类输入
    /// 会静默丢前缀，语义是"取名"而不是"拒绝"。
    ///
    /// 契约（GAP-2 已登记，行为按设计保留）：`target_path` 依赖上游
    /// `parse_request` 先对 from/toDir 过 `normalize_remote_path`（`..` 收敛、
    /// 拒绝根）。本函数自身不拒绝含 `..`/多段的名字输入——它按最后一段取名，
    /// 非 basename 输入被静默改写而非报错。若未来有新调用方绕过
    /// `parse_request`，必须先在其入口补 normalize，或在这里加单段断言/
    /// 显式 Err，二者缺一不可。
    #[test]
    fn target_path_takes_only_the_final_name_segment() {
        // 非 basename 输入：落到 toDir 下最后一个段，前缀被丢而不是拼接。
        assert_eq!(target_path("/dst", "a/b/c.txt"), "/dst/c.txt");
        // `..` 段名字：`/var/log/../etc/passwd` 的最后段是 passwd，目标
        // 仍在 /dst 内，无法穿越出 toDir。
        assert_eq!(target_path("/dst", "/var/log/../etc/passwd"), "/dst/passwd");
        assert!(!target_path("/dst", "/var/log/../etc/passwd").contains(".."));
        // 空名字（from 全是斜杠）：回退为 "copy" 占位名，不产生尾斜杠目标。
        assert_eq!(target_path("/dst", "///"), "/dst/copy");
    }

    #[test]
    fn same_directory_detects_rename_candidates() {
        assert!(same_directory("/tmp/a.txt", "/tmp"));
        assert!(same_directory("/a", "/"));
        assert!(!same_directory("/var/log/app.log", "/tmp"));
        assert!(!same_directory("/tmp/sub/a.txt", "/tmp"));
    }

    #[test]
    fn probe_command_lists_every_target_with_true_tail() {
        let command = build_exists_probe_command(&["/tmp/one".to_string(), "/tmp/two".to_string()]);
        assert_eq!(
            command,
            "test -e '/tmp/one' && echo 0; test -e '/tmp/two' && echo 1; true"
        );
    }

    #[test]
    fn existing_targets_reduce_probe_output() {
        assert_eq!(
            existing_targets("1\nnoise\n0\n", 3),
            vec![true, true, false]
        );
        assert_eq!(existing_targets("", 2), vec![false, false]);
        // Out-of-range indices are ignored.
        assert_eq!(existing_targets("5", 2), vec![false, false]);
    }

    #[test]
    fn outcome_json_matches_the_frontend_contract() {
        let outcome = CopyMoveOutcome {
            success: false,
            results: vec![
                ItemOutcome::ok("/a/one.txt", "/dst/one.txt"),
                ItemOutcome::failed(
                    "/a/two.txt",
                    "/dst/two.txt",
                    "copy failed (exit 1): cp: cannot stat".to_string(),
                ),
            ],
        };
        let value = outcome.into_json();
        assert_eq!(value["success"], false);
        let results = value["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["from"], "/a/one.txt");
        assert_eq!(results[0]["to"], "/dst/one.txt");
        assert_eq!(results[0]["ok"], true);
        assert!(results[0].get("error").is_none(), "ok items carry no error");
        assert_eq!(results[1]["ok"], false);
        assert_eq!(results[1]["error"], "copy failed (exit 1): cp: cannot stat");

        let all_ok = CopyMoveOutcome {
            success: true,
            results: vec![ItemOutcome::ok("/a", "/b")],
        };
        assert_eq!(all_ok.into_json()["success"], true);
    }
}
