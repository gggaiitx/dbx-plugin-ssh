import { describe, expect, it, vi } from "vitest";
import {
  canStartTrzszTransfer,
  createBufferTrzszWriter,
  createFileTrzszReader,
  createTrzszProgressCallback,
  detectTrzszAnnounce,
  detectTrzszAnnounceFromBytes,
  flattenTrzszPathName,
  formatTrzszSavedFiles,
  initialTrzszProgressState,
  installTrzszHandlers,
  isTrzszStopMessage,
  parseTrzszRemoteName,
  reduceTrzszProgress,
  resolveTerminalInputRoute,
  trzszProgressPercent,
  type TrzszDownloadFile,
  type TrzszProgressEvent,
  type TrzszProgressState,
} from "./terminalTrzsz";

describe("trzsz announce detection", () => {
  it("maps S to download and R/D to upload (D allowing directories)", () => {
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:S:1.0.0")).toEqual({ direction: "download", directory: false, version: "1.0.0" });
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:R:1.1.12")).toEqual({ direction: "upload", directory: false, version: "1.1.12" });
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:D:1.1.12")).toEqual({ direction: "upload", directory: true, version: "1.1.12" });
  });

  it("keeps the unique id suffix out of the version and matches announce inside output noise", () => {
    const announce = detectTrzszAnnounce("trz available\r\n::TRZSZ:TRANSFER:S:1.0.0:12345678901234\r\n");
    expect(announce?.version).toBe("1.0.0");
    expect(announce?.direction).toBe("download");
  });

  it("rejects plain text and malformed magic keys", () => {
    expect(detectTrzszAnnounce("total 42\ndrwxr-xr-x root")).toBeNull();
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:X:1.0.0")).toBeNull();
    expect(detectTrzszAnnounce("::TRZSZ:TRANSFER:S:abc")).toBeNull();
    expect(detectTrzszAnnounce("")).toBeNull();
  });

  it("detects announces in raw PTY bytes", () => {
    const bytes = new TextEncoder().encode("\x1b[0m::TRZSZ:TRANSFER:R:1.0.0:42");
    expect(detectTrzszAnnounceFromBytes(bytes)?.direction).toBe("upload");
    expect(detectTrzszAnnounceFromBytes(new TextEncoder().encode("hello"))).toBeNull();
  });

  it("does not fire on an announce split across two PTY frames", () => {
    // Detection is per-frame: a UTF-8 greeting cut mid-character followed by an
    // announce cut mid-magic means neither frame holds a full match. The half
    // announce must never trigger the overlay or stream takeover.
    const first = new TextEncoder().encode("日志输出 你好 ::TRZSZ:TRANSFER:");
    const second = new TextEncoder().encode("S:1.0.0:42\r\n");
    expect(detectTrzszAnnounceFromBytes(first)).toBeNull();
    expect(detectTrzszAnnounceFromBytes(second)).toBeNull();
  });

  it("does not fire on a half announce inside a single frame", () => {
    expect(detectTrzszAnnounceFromBytes(new TextEncoder().encode("::TRZSZ:TRANSFER:S"))).toBeNull();
    expect(detectTrzszAnnounceFromBytes(new TextEncoder().encode("::TRZSZ:TRANSFER:S1.0.0"))).toBeNull();
  });

  it("still matches a complete announce preceded by a truncated multibyte sequence", () => {
    // A dangling lead byte of a 3-byte UTF-8 char maps to one Latin1 char; the
    // byte-wise scan must keep the following ASCII announce intact.
    const bytes = new Uint8Array([0xe4, ...new TextEncoder().encode("::TRZSZ:TRANSFER:D:1.1.12")]);
    const announce = detectTrzszAnnounceFromBytes(bytes);
    expect(announce?.direction).toBe("upload");
    expect(announce?.directory).toBe(true);
    expect(announce?.version).toBe("1.1.12");
  });

  it("finds an announce straddling the internal 8192-byte chunk boundary", () => {
    // The scanner concatenates 8192-byte Latin1 chunks before matching, so an
    // announce broken across its own chunking must still be found.
    const noise = "x".repeat(8190);
    const bytes = new TextEncoder().encode(`${noise}::TRZSZ:TRANSFER:S:1.0.0`);
    expect(detectTrzszAnnounceFromBytes(bytes)?.direction).toBe("download");
  });
});

describe("file transfer stream ownership (mutual exclusion with zmodem)", () => {
  it("routes keyboard input to the trzsz filter only while it owns the stream", () => {
    expect(resolveTerminalInputRoute({ zmodemBusy: false, trzszBusy: false })).toBe("pty");
    expect(resolveTerminalInputRoute({ zmodemBusy: false, trzszBusy: true })).toBe("trzsz");
    expect(resolveTerminalInputRoute({ zmodemBusy: true, trzszBusy: false })).toBe("blocked");
    expect(resolveTerminalInputRoute({ zmodemBusy: true, trzszBusy: true })).toBe("trzsz");
  });

  it("only allows a trzsz takeover when no other transfer protocol is active", () => {
    expect(canStartTrzszTransfer({ zmodemBusy: false, trzszBusy: false })).toBe(true);
    expect(canStartTrzszTransfer({ zmodemBusy: true, trzszBusy: false })).toBe(false);
    expect(canStartTrzszTransfer({ zmodemBusy: false, trzszBusy: true })).toBe(false);
  });
});

function reduceAll(events: TrzszProgressEvent[], initial: TrzszProgressState = initialTrzszProgressState()): TrzszProgressState {
  return events.reduce((state, event) => reduceTrzszProgress(state, event), initial);
}

describe("trzsz progress state machine", () => {
  it("walks waiting -> transferring -> success across multiple files", () => {
    const state = reduceAll([
      { type: "waiting", direction: "download" },
      { type: "started", direction: "download" },
      { type: "num", count: 2 },
      { type: "name", name: "a.log" },
      { type: "size", size: 100 },
      { type: "step", step: 40 },
      { type: "step", step: 100 },
      { type: "file-done" },
      { type: "name", name: "b.bin" },
      { type: "size", size: 50 },
      { type: "step", step: 25 },
    ]);
    expect(state.phase).toBe("transferring");
    expect(state.fileIndex).toBe(2);
    expect(state.fileCount).toBe(2);
    expect(state.fileName).toBe("b.bin");
    expect(state.fileTransferred).toBe(25);
    expect(state.totalTransferred).toBe(125);
    expect(state.totalSize).toBe(150);
    expect(trzszProgressPercent(state)).toBe(83);
  });

  it("reaches 100 percent on success even without a final size", () => {
    const state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "num", count: 1 },
      { type: "name", name: "empty.txt" },
      { type: "size", size: 0 },
      { type: "success" },
    ]);
    expect(state.phase).toBe("success");
    expect(trzszProgressPercent(state)).toBe(100);
  });

  it("falls back to the current file for the percent while totals are unknown", () => {
    const state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "name", name: "a.log" },
      { type: "size", size: 200 },
      { type: "step", step: 50 },
    ]);
    expect(trzszProgressPercent(state)).toBe(25);
  });

  it("records failures with their message and resets on cancelled", () => {
    const failed = reduceAll([
      { type: "started", direction: "upload" },
      { type: "failure", message: "boom" },
    ]);
    expect(failed.phase).toBe("failed");
    expect(failed.message).toBe("boom");
    expect(reduceTrzszProgress(failed, { type: "cancelled" })).toEqual(initialTrzszProgressState());
  });

  it("does not count past the file size on trailing steps", () => {
    const state = reduceAll([
      { type: "started", direction: "download" },
      { type: "name", name: "a.log" },
      { type: "size", size: 10 },
      { type: "step", step: 99 },
    ]);
    expect(state.fileTransferred).toBe(10);
  });
});

describe("trzsz progress idempotency (stale / out-of-order events)", () => {
  it("treats a repeated step at the same offset as a no-op (stale ACK re-delivery)", () => {
    // electerm's xmodem hardening idea: a duplicate progress callback (same
    // offset delivered twice) must not move the bar backwards or double count.
    let state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "num", count: 1 },
      { type: "name", name: "a.log" },
      { type: "size", size: 100 },
      { type: "step", step: 40 },
    ]);
    state = reduceTrzszProgress(state, { type: "step", step: 40 });
    expect(state.fileTransferred).toBe(40);
    expect(state.totalTransferred).toBe(40);
  });

  it("ignores a regressing step so the progress bar never jumps backwards", () => {
    // Monotonic clamp: an out-of-order (older) progress callback must not drag
    // fileTransferred or totalTransferred back down — the bar stays at the
    // highest offset seen for the file.
    let state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "num", count: 1 },
      { type: "name", name: "a.log" },
      { type: "size", size: 100 },
      { type: "step", step: 80 },
    ]);
    state = reduceTrzszProgress(state, { type: "step", step: 30 });
    expect(state.fileTransferred).toBe(80);
    expect(state.totalTransferred).toBe(80);
  });

  it("clamps fileIndex at the declared fileCount on a duplicate name event", () => {
    // A re-delivered `name` callback (same file announced twice) must not push
    // the "file N of M" label past the declared count: the reducer clamps the
    // index with Math.min(index + 1, fileCount).
    let state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "num", count: 1 },
      { type: "name", name: "a.log" },
    ]);
    state = reduceTrzszProgress(state, { type: "name", name: "a.log" });
    expect(state.fileIndex).toBe(1);
    expect(state.fileCount).toBe(1);
    expect(state.fileName).toBe("a.log");
    expect(state.fileTransferred).toBe(0);
  });

  it("folds the clamped step into totalTransferred on an oversized trailing step", () => {
    // fileTransferred is clamped to fileSize, and totalTransferred is built
    // from the same clamped step: a trailing oversized step must not inflate
    // the session total above totalSize (percent then saturates at 100).
    const state = reduceAll([
      { type: "started", direction: "download" },
      { type: "name", name: "a.log" },
      { type: "size", size: 10 },
      { type: "step", step: 99 },
    ]);
    expect(state.fileTransferred).toBe(10);
    expect(state.totalTransferred).toBe(10);
  });

  it("does not double-accumulate totalSize when the same file reports its size twice", () => {
    // A repeated `size` callback for one file must fold into totalSize once:
    // the reducer remembers which file name last declared its size and only a
    // fresh `name` re-arms the accumulation.
    const state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "name", name: "a.log" },
      { type: "size", size: 100 },
      { type: "size", size: 100 },
      { type: "step", step: 100 },
    ]);
    expect(state.totalSize).toBe(100);
    expect(state.fileSize).toBe(100);
    expect(trzszProgressPercent(state)).toBe(100);
  });

  it("re-arms the totalSize accumulation when a new file declares its size", () => {
    // The dedupe key resets per file: b.log's size must still count even
    // though a.log declared before it.
    const state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "num", count: 2 },
      { type: "name", name: "a.log" },
      { type: "size", size: 100 },
      { type: "step", step: 100 },
      { type: "file-done" },
      { type: "name", name: "b.log" },
      { type: "size", size: 50 },
    ]);
    expect(state.totalSize).toBe(150);
  });

  it("returns to a clean idle state after reset and accepts a fresh transfer", () => {
    let state = reduceAll([
      { type: "waiting", direction: "download" },
      { type: "started", direction: "download" },
      { type: "num", count: 2 },
      { type: "name", name: "a.log" },
      { type: "size", size: 100 },
      { type: "step", step: 40 },
    ]);
    state = reduceTrzszProgress(state, { type: "reset" });
    expect(state).toEqual(initialTrzszProgressState());
    // A brand-new session after the reset starts from zero, not from the
    // previous transfer's leftovers.
    state = reduceAll(
      [
        { type: "waiting", direction: "upload" },
        { type: "started", direction: "upload" },
        { type: "num", count: 1 },
        { type: "name", name: "b.log" },
        { type: "size", size: 50 },
        { type: "step", step: 25 },
      ],
      state,
    );
    expect(state.fileIndex).toBe(1);
    expect(state.fileCount).toBe(1);
    expect(state.fileTransferred).toBe(25);
    expect(state.totalTransferred).toBe(25);
    expect(state.totalSize).toBe(50);
    expect(trzszProgressPercent(state)).toBe(50);
  });

  it("zeroes progress when the same file name is transferred a second time via started", () => {
    // A re-run of `trz` for the same file: the new `started` event rebuilds
    // state from scratch, so the bar must restart at 0% not resume 100%.
    const first = reduceAll([
      { type: "waiting", direction: "download" },
      { type: "started", direction: "download" },
      { type: "num", count: 1 },
      { type: "name", name: "same.log" },
      { type: "size", size: 80 },
      { type: "step", step: 80 },
      { type: "file-done" },
      { type: "success" },
    ]);
    expect(first.phase).toBe("success");
    expect(trzszProgressPercent(first)).toBe(100);
    const second = reduceAll([
      { type: "waiting", direction: "download" },
      { type: "started", direction: "download" },
      { type: "num", count: 1 },
      { type: "name", name: "same.log" },
      { type: "size", size: 80 },
      { type: "step", step: 10 },
    ]);
    expect(second.fileTransferred).toBe(10);
    expect(second.totalTransferred).toBe(10);
    expect(second.totalSize).toBe(80);
    expect(trzszProgressPercent(second)).toBe(13);
  });

  it("clears the stale totalSize when a re-run skips waiting/started (num only)", () => {
    // `num` re-arms the session counters including totalSize: a second
    // transfer that begins without a fresh waiting/started pair must divide
    // the overall percent by its own declared size, not the leftover total.
    let state = reduceAll([
      { type: "started", direction: "download" },
      { type: "num", count: 1 },
      { type: "name", name: "a.log" },
      { type: "size", size: 100 },
      { type: "step", step: 100 },
      { type: "file-done" },
      { type: "success" },
    ]);
    state = reduceAll(
      [
        { type: "num", count: 1 },
        { type: "name", name: "a.log" },
        { type: "size", size: 100 },
        { type: "step", step: 50 },
      ],
      state,
    );
    expect(state.totalTransferred).toBe(50);
    expect(state.totalSize).toBe(100);
    expect(trzszProgressPercent(state)).toBe(50);
  });
});

describe("trzsz progress percent clamping", () => {
  it("reports 0 percent while nothing is known (totalSize and fileSize both 0)", () => {
    const state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "num", count: 1 },
      { type: "name", name: "mystery.bin" },
      { type: "step", step: 42 },
    ]);
    expect(state.totalSize).toBe(0);
    expect(state.fileSize).toBe(0);
    expect(trzszProgressPercent(state)).toBe(0);
  });

  it("saturates at 100 percent when steps overflow a lying server-side size", () => {
    // Server declared 10 bytes but keeps pushing progress beyond it: the
    // percent must clamp into [0, 100], never exceed 100 or go negative.
    const state = reduceAll([
      { type: "started", direction: "download" },
      { type: "name", name: "a.log" },
      { type: "size", size: 10 },
      { type: "step", step: 500 },
    ]);
    const percent = trzszProgressPercent(state);
    expect(percent).toBe(100);
    expect(percent).toBeLessThanOrEqual(100);
    expect(percent).toBeGreaterThanOrEqual(0);
  });

  it("stays within [0, 100] across multi-file overflow accumulation", () => {
    const state = reduceAll([
      { type: "started", direction: "download" },
      { type: "num", count: 2 },
      { type: "name", name: "a.log" },
      { type: "size", size: 5 },
      { type: "step", step: 999 },
      { type: "file-done" },
      { type: "name", name: "b.log" },
      { type: "size", size: 5 },
      { type: "step", step: 999 },
    ]);
    expect(trzszProgressPercent(state)).toBe(100);
  });
});

describe("trzsz input route priority", () => {
  it("gives trzsz ownership precedence when zmodem is busy too", () => {
    // Both protocols busy can only happen through a state-machine slip, but
    // the tie-break must stay deterministic: trzsz owns the live stream (its
    // filter still needs Ctrl+C), zmodem alone blocks input outright.
    expect(resolveTerminalInputRoute({ zmodemBusy: true, trzszBusy: true })).toBe("trzsz");
    expect(resolveTerminalInputRoute({ zmodemBusy: true, trzszBusy: false })).toBe("blocked");
    expect(resolveTerminalInputRoute({ zmodemBusy: false, trzszBusy: true })).toBe("trzsz");
    expect(resolveTerminalInputRoute({ zmodemBusy: false, trzszBusy: false })).toBe("pty");
  });
});

describe("trzsz progress callback adapter", () => {
  it("maps the transfer callbacks onto reducer events", () => {
    const events: TrzszProgressEvent[] = [];
    const callbacks = createTrzszProgressCallback((event) => events.push(event));
    callbacks.onNum(1);
    callbacks.onName("a.log");
    callbacks.onSize(3);
    callbacks.onStep(2);
    callbacks.onDone();
    expect(events).toEqual([
      { type: "num", count: 1 },
      { type: "name", name: "a.log" },
      { type: "size", size: 3 },
      { type: "step", step: 2 },
      { type: "file-done" },
    ]);
  });

  it("feeds a full multi-file download without tripping the clamps", () => {
    // Replay of a realistic TrzszTransfer callback sequence through the
    // adapter + reducer: the resulting percent must stay in [0, 100] even
    // when the final onDone accumulates the file's bytes into completedTransferred.
    const events: TrzszProgressEvent[] = [];
    const callbacks = createTrzszProgressCallback((event) => events.push(event));
    callbacks.onNum(2);
    callbacks.onName("a.log");
    callbacks.onSize(40);
    callbacks.onStep(40);
    callbacks.onDone();
    callbacks.onName("b.log");
    callbacks.onSize(60);
    callbacks.onStep(30);
    let state = events.reduce((acc, event) => reduceTrzszProgress(acc, event), initialTrzszProgressState());
    expect(state.fileIndex).toBe(2);
    expect(state.completedTransferred).toBe(40);
    expect(state.totalTransferred).toBe(70);
    const percent = trzszProgressPercent(state);
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);
    expect(percent).toBe(70);
  });

  it("passes through negative and NaN steps unchanged for the reducer to clamp", () => {
    // The adapter is a pure event mapper: hostile callback values reach the
    // reducer verbatim, whose Math.max(0, step) clamp is the defense line.
    const events: TrzszProgressEvent[] = [];
    const callbacks = createTrzszProgressCallback((event) => events.push(event));
    callbacks.onStep(-5);
    callbacks.onSize(Number.NaN);
    expect(events).toEqual([
      { type: "step", step: -5 },
      { type: "size", size: Number.NaN },
    ]);
    let state = events.reduce((acc, event) => reduceTrzszProgress(acc, event), initialTrzszProgressState());
    expect(state.fileTransferred).toBe(0);
    // The reducer's defense line: a NaN size is not a real declaration, so it
    // is ignored entirely — fileSize/totalSize stay at their previous (finite)
    // values and never get poisoned.
    expect(state.fileSize).toBe(0);
    expect(state.totalSize).toBe(0);
    expect(Number.isFinite(state.fileSize)).toBe(true);
    expect(trzszProgressPercent(state)).toBe(0);
  });

  it("ignores a NaN size while keeping a previously declared size intact", () => {
    // NaN arrives after a valid declaration: the guard must keep the real
    // sizes instead of overwriting fileSize with NaN.
    const state = reduceAll([
      { type: "started", direction: "upload" },
      { type: "name", name: "a.log" },
      { type: "size", size: 200 },
      { type: "size", size: Number.NaN },
      { type: "step", step: 50 },
    ]);
    expect(state.fileSize).toBe(200);
    expect(state.totalSize).toBe(200);
    expect(state.fileTransferred).toBe(50);
    expect(trzszProgressPercent(state)).toBe(25);
  });
});

describe("trzsz remote name parsing for browser saves", () => {
  it("keeps plain file names untouched", () => {
    expect(parseTrzszRemoteName("a.log", false)).toEqual({ fileName: "a.log", isDirectory: false });
  });

  it("flattens directory download paths and detects directory entries", () => {
    const json = JSON.stringify({ path_id: "id1", path_name: ["dir", "sub", "a.log"], is_dir: false });
    expect(parseTrzszRemoteName(json, true)).toEqual({ fileName: "dir-sub-a.log", isDirectory: false });
    const dirJson = JSON.stringify({ path_id: "id2", path_name: ["dir"], is_dir: true });
    expect(parseTrzszRemoteName(dirJson, true)).toEqual({ fileName: "dir", isDirectory: true });
  });

  it("falls back to the raw name for malformed directory payloads", () => {
    expect(parseTrzszRemoteName("not json", true)).toEqual({ fileName: "not json", isDirectory: false });
    expect(flattenTrzszPathName("nope")).toBe("");
    expect(flattenTrzszPathName(["a", "", 3, "b"])).toBe("a-b");
  });

  it("flattens traversal-shaped directory paths into flat names, never paths", () => {
    // A hostile path_name carrying traversal segments must flatten into a
    // hyphen-joined single name: the local save path is then further guarded
    // by the sidecar's sanitize_file_name, so neither layer can be bypassed
    // by `../../` segments inside a trzsz directory entry.
    const hostile = JSON.stringify({
      path_id: "id3",
      path_name: ["..", "..", "etc", "passwd"],
      is_dir: false,
    });
    const parsed = parseTrzszRemoteName(hostile, true);
    expect(parsed.fileName).toBe("..-..-etc-passwd");
    expect(parsed.fileName).not.toContain("/");
    expect(parsed.fileName).not.toContain("\\");
  });
});

describe("browser file reader", () => {
  it("serves sequential chunks and an empty EOF read", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const file = new File([payload], "a.bin");
    const reader = createFileTrzszReader(3, file);
    expect(reader.getSize()).toBe(5);
    expect(reader.getRelPath()).toEqual(["a.bin"]);
    expect(reader.getPathId()).toBe(3);
    expect(reader.isDir()).toBe(false);
    const first = await reader.readFile(new ArrayBuffer(3));
    expect([...first]).toEqual([1, 2, 3]);
    const second = await reader.readFile(new ArrayBuffer(3));
    expect([...second]).toEqual([4, 5]);
    expect(await reader.readFile(new ArrayBuffer(3))).toHaveLength(0);
    reader.closeFile();
    expect(await reader.readFile(new ArrayBuffer(3))).toHaveLength(0);
  });
});

describe("in-memory download writer", () => {
  it("accumulates chunks into the sink and reports the byte length", async () => {
    const target: TrzszDownloadFile = { fileName: "a.log", isDirectory: false, chunks: [], byteLength: 0 };
    const writer = createBufferTrzszWriter(target);
    expect(writer.getLocalName()).toBe("a.log");
    await writer.writeFile(new Uint8Array([1, 2]));
    await writer.writeFile(new Uint8Array([3]));
    writer.closeFile();
    expect(target.chunks.map((chunk) => [...chunk])).toEqual([[1, 2], [3]]);
    expect(target.byteLength).toBe(3);
    expect(await writer.deleteFile()).toBe("");
  });

  it("rejects writes after close", async () => {
    const target: TrzszDownloadFile = { fileName: "a.log", isDirectory: false, chunks: [], byteLength: 0 };
    const writer = createBufferTrzszWriter(target);
    writer.closeFile();
    await expect(writer.writeFile(new Uint8Array([1]))).rejects.toThrow(/after close/);
  });

  it("marks directory entries without buffering data", () => {
    const target: TrzszDownloadFile = { fileName: "dir", isDirectory: true, chunks: [], byteLength: 0 };
    const writer = createBufferTrzszWriter(target);
    expect(writer.isDir()).toBe(true);
  });
});

describe("trzsz filter handler bridge", () => {
  interface FakeTransfer {
    sendAction: ReturnType<typeof vi.fn>;
    recvConfig: ReturnType<typeof vi.fn>;
    sendFiles: ReturnType<typeof vi.fn>;
    recvFiles: ReturnType<typeof vi.fn>;
    clientExit: ReturnType<typeof vi.fn>;
  }

  function createFakeFilter(transfer: Partial<FakeTransfer>) {
    const fakeTransfer = {
      sendAction: vi.fn().mockResolvedValue(undefined),
      recvConfig: vi.fn().mockResolvedValue({ binary: true }),
      sendFiles: vi.fn().mockResolvedValue(["remote-a.log"]),
      recvFiles: vi.fn().mockResolvedValue(["a.log"]),
      clientExit: vi.fn().mockResolvedValue(undefined),
      ...transfer,
    };
    const filter = { trzszTransfer: fakeTransfer, uploadFilesList: null } as unknown as Parameters<typeof installTrzszHandlers>[0];
    return { filter, fakeTransfer };
  }

  it("uploads picked files and reports success", async () => {
    const { filter, fakeTransfer } = createFakeFilter({});
    const events: TrzszProgressEvent[] = [];
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn().mockResolvedValue([new File([new Uint8Array([1])], "a.log")]),
      saveDownloadedFiles: vi.fn().mockResolvedValue(undefined),
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszUploadFiles: (version: string, directory: boolean, remoteIsWindows: boolean) => Promise<void> };
    await internals.handleTrzszUploadFiles("1.0.0", false, false);
    expect(fakeTransfer.sendAction).toHaveBeenCalledWith(true, false);
    expect(fakeTransfer.sendFiles).toHaveBeenCalledTimes(1);
    expect(fakeTransfer.clientExit).toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["started", "success"]);
  });

  it("declines the transfer and emits cancelled when the user aborts the picker", async () => {
    const { filter, fakeTransfer } = createFakeFilter({});
    const events: TrzszProgressEvent[] = [];
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn().mockResolvedValue(undefined),
      saveDownloadedFiles: vi.fn().mockResolvedValue(undefined),
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszUploadFiles: (version: string, directory: boolean, remoteIsWindows: boolean) => Promise<void> };
    await internals.handleTrzszUploadFiles("1.0.0", false, false);
    expect(fakeTransfer.sendAction).toHaveBeenCalledWith(false, false);
    expect(fakeTransfer.sendFiles).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(["cancelled"]);
  });

  it("emits failure and rethrows upload errors so the filter can notify the remote", async () => {
    const { filter, fakeTransfer } = createFakeFilter({ sendFiles: vi.fn().mockRejectedValue(new Error("disk full")) });
    const events: TrzszProgressEvent[] = [];
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn().mockResolvedValue([new File([new Uint8Array([1])], "a.log")]),
      saveDownloadedFiles: vi.fn().mockResolvedValue(undefined),
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszUploadFiles: (version: string, directory: boolean, remoteIsWindows: boolean) => Promise<void> };
    await expect(internals.handleTrzszUploadFiles("1.0.0", false, false)).rejects.toThrow("disk full");
    expect(events.at(-1)).toEqual({ type: "failure", message: "disk full" });
  });

  it("buffers downloaded chunks and hands finished files to the save bridge", async () => {
    const { filter, fakeTransfer } = createFakeFilter({
      recvFiles: vi.fn().mockImplementation(async (_saveParam: unknown, openSaveFile: (param: unknown, name: string, directory: boolean, overwrite: boolean) => Promise<{ writeFile: (buf: Uint8Array) => Promise<void>; closeFile: () => void; getLocalName: () => string }>) => {
        const writer = await openSaveFile(null, "a.log", false, false);
        await writer.writeFile(new Uint8Array([7, 7, 7]));
        writer.closeFile();
        return [writer.getLocalName()];
      }),
    });
    const events: TrzszProgressEvent[] = [];
    const saveDownloadedFiles = vi.fn().mockResolvedValue(undefined);
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn(),
      saveDownloadedFiles,
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszDownloadFiles: (version: string, remoteIsWindows: boolean) => Promise<void> };
    await internals.handleTrzszDownloadFiles("1.0.0", false);
    expect(fakeTransfer.sendAction).toHaveBeenCalledWith(true, false);
    expect(fakeTransfer.clientExit).toHaveBeenCalled();
    expect(saveDownloadedFiles).toHaveBeenCalledTimes(1);
    const saved = saveDownloadedFiles.mock.calls[0][0] as TrzszDownloadFile[];
    expect(saved).toHaveLength(1);
    expect(saved[0].fileName).toBe("a.log");
    expect(saved[0].byteLength).toBe(3);
    expect(events.map((event) => event.type)).toEqual(["started", "success"]);
  });

  it("does not save anything when the download transfer fails", async () => {
    const { filter } = createFakeFilter({ recvFiles: vi.fn().mockRejectedValue(new Error("timeout")) });
    const events: TrzszProgressEvent[] = [];
    const saveDownloadedFiles = vi.fn().mockResolvedValue(undefined);
    installTrzszHandlers(filter, {
      pickUploadFiles: vi.fn(),
      saveDownloadedFiles,
      emit: (event) => events.push(event),
    });
    const internals = filter as unknown as { handleTrzszDownloadFiles: (version: string, remoteIsWindows: boolean) => Promise<void> };
    await expect(internals.handleTrzszDownloadFiles("1.0.0", false)).rejects.toThrow("timeout");
    expect(saveDownloadedFiles).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: "failure", message: "timeout" });
  });
});

describe("trzsz helpers", () => {
  it("recognizes the Ctrl+C stop error", () => {
    expect(isTrzszStopMessage("Stopped")).toBe(true);
    expect(isTrzszStopMessage("Stopped ")).toBe(true);
    expect(isTrzszStopMessage("Receive data timeout")).toBe(false);
  });

  it("formats the saved-files exit message for the remote terminal", () => {
    expect(formatTrzszSavedFiles(["a.log", "b.log"])).toBe("Saved 2 files/directories\r\n- a.log\r\n- b.log");
    expect(formatTrzszSavedFiles(["a.log"])).toBe("Saved 1 file/directory\r\n- a.log");
  });
});
