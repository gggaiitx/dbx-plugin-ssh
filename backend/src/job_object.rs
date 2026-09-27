//! Process-wide Windows Job Object: kill-on-close teardown for every child
//! the sidecar spawns (local-terminal ConPTY trees included).
//!
//! The ConPTY conhost that `CreatePseudoConsole` starts is spawned before the
//! shell and is not the shell's child, so a per-shell kill cannot reach it.
//! When the sidecar itself dies (crash, update, host exit) nothing otherwise
//! reaps the tree: orphaned shells linger and their headless conhosts keep
//! burning a full core each (observed live). Assigning the whole process to
//! one job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` hands the cleanup to the
//! kernel: the job handle lives for the process lifetime, and when the
//! process exits (any way at all) the handle closes and every process in the
//! tree dies with it. Same pattern VS Code / Windows Terminal use.
//!
//! The handle is deliberately never closed before exit, and assignment
//! failure is logged but never fatal — a shared job from the host process
//! (breakaway denied) must not take the sidecar down.

#![cfg(windows)]

use std::ffi::c_void;
use std::sync::Once;

use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;

const LOG_PREFIX: &str = "[ssh-sftp-plugin] job-object:";

/// Bind the current process to a kill-on-close job exactly once per process.
/// Fire-and-forget: called from `main` before serving, failures only log.
pub fn setup_process_job() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        if let Err(error) = create_and_assign() {
            eprintln!("{LOG_PREFIX} setup failed: {error}");
        }
    });
}

fn create_and_assign() -> Result<(), String> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(format!(
                "CreateJobObjectW failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            let error = std::io::Error::last_os_error();
            let _ = windows_sys::Win32::Foundation::CloseHandle(job);
            return Err(format!("SetInformationJobObject failed: {error}"));
        }

        // The sidecar may already live in a host-created job; Windows 8+
        // supports nested jobs so assignment normally succeeds, but a denied
        // breakaway on older systems is survivable — children just lose the
        // kernel teardown net, the graceful-close path still applies.
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            let error = std::io::Error::last_os_error();
            let _ = windows_sys::Win32::Foundation::CloseHandle(job);
            return Err(format!("AssignProcessToJobObject failed: {error}"));
        }

        // Intentional leak: kill-on-close fires when this handle closes at
        // process exit. Closing it here would kill the tree immediately.
        eprintln!(
            "{LOG_PREFIX} kill-on-close job active (pid={})",
            std::process::id()
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_is_idempotent_and_does_not_panic() {
        setup_process_job();
        // Second call goes through the same Once — no double-create panic.
        setup_process_job();
    }

    #[test]
    fn create_and_assign_succeeds_on_test_process() {
        // The test binary is its own process tree root; assignment must work
        // on a plain Windows 10/11 box. Idempotent across tests in the same
        // binary because a second assignment nests on Win8+.
        create_and_assign().expect("job create+assign should succeed");
    }
}
