import { describe, expect, it, vi } from "vitest";
import {
  createZmodemSentry,
  decideZmodemDetection,
  sendZmodemFiles,
  validTransferOffset,
  type ZmodemSentryHandlers,
} from "./terminalZmodem";

function stubDetection(role: string) {
  return {
    get_session_role: () => role,
    deny: vi.fn(),
    confirm: vi.fn(),
  };
}

describe("zmodem detection decision", () => {
  it("confirms only a send-role session while an upload is pending", () => {
    const decision = decideZmodemDetection(stubDetection("send"), true);
    expect(decision).toEqual({ action: "confirm" });
  });

  it("denies a send-role offer when nothing is queued locally (unrequested sz)", () => {
    const detection = stubDetection("send");
    const decision = decideZmodemDetection(detection, false);
    expect(decision).toEqual({ action: "deny", reason: "receiveOffer" });
    // Tabby parity: the deny path must actually call deny() so the peer's
    // rz/zmodem session terminates instead of hanging the wire.
    expect(detection.deny).not.toHaveBeenCalled(); // decision is pure; the caller denies
  });

  it("denies a receive-role session even when an upload is pending", () => {
    const decision = decideZmodemDetection(stubDetection("receive"), true);
    expect(decision).toEqual({ action: "deny", reason: "roleMismatch" });
  });

  it("classifies unknown session roles as a roleMismatch while an upload is pending", () => {
    // zmodem.js may surface roles other than the canonical send/receive pair
    // (e.g. "unknown" on a half-opened session). Only a confirmed "send" may
    // ever be confirmed, so anything unrecognized is denied as a mismatch.
    expect(decideZmodemDetection(stubDetection("unknown"), true)).toEqual({ action: "deny", reason: "roleMismatch" });
  });

  it("classifies unknown roles as an unrequested offer when nothing is queued", () => {
    expect(decideZmodemDetection(stubDetection("unknown"), false)).toEqual({ action: "deny", reason: "receiveOffer" });
  });

  it("treats empty and synthetic role strings like any other unrecognized role", () => {
    expect(decideZmodemDetection(stubDetection(""), true)).toEqual({ action: "deny", reason: "roleMismatch" });
    expect(decideZmodemDetection(stubDetection("Send"), true)).toEqual({ action: "deny", reason: "roleMismatch" });
  });
});

describe("validTransferOffset clamping", () => {
  it("accepts in-range offsets and clamps adversarial values to zero", () => {
    expect(validTransferOffset({ get_offset: () => 4096 } as never, 8192)).toBe(4096);
    expect(validTransferOffset({ get_offset: () => 0 } as never, 8192)).toBe(0);
    // Negative offsets (hostile/corrupt peer) never underflow the resume base.
    expect(validTransferOffset({ get_offset: () => -1 } as never, 8192)).toBe(0);
    // Offsets beyond the file size would hang the chunk loop forever.
    expect(validTransferOffset({ get_offset: () => 9000 } as never, 8192)).toBe(0);
    expect(validTransferOffset({ get_offset: () => Number.NaN } as never, 8192)).toBe(0);
    expect(validTransferOffset({ get_offset: () => Number.POSITIVE_INFINITY } as never, 8192)).toBe(0);
  });
});

describe("createZmodemSentry", () => {
  it("returns a usable sentry wired to the caller's handlers", () => {
    const handlers: ZmodemSentryHandlers = {
      send: vi.fn(),
      toTerminal: vi.fn(),
      onDetect: vi.fn(),
      onRetract: vi.fn(),
    };
    const sentry = createZmodemSentry(handlers);
    expect(sentry).toBeDefined();
  });
});

describe("sendZmodemFiles", () => {
  it("rejects when the session is aborted mid-transfer", async () => {
    // The abort check fires inside the chunk loop, i.e. only after the peer
    // accepted the offer: a rejected offer skips the file instead.
    const transfer = {
      get_offset: () => 0,
      send: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
    };
    const session = {
      aborted: () => true,
      send_offer: vi.fn().mockResolvedValue(transfer),
      close: vi.fn().mockResolvedValue(undefined),
    } as never;
    const file = new File([new Uint8Array(8)], "a.bin");
    await expect(sendZmodemFiles(session, [file])).rejects.toThrow("ZMODEM session aborted");
  });

  it("skips a file whose offer was rejected and still closes the session", async () => {
    const session = {
      aborted: () => false,
      send_offer: vi.fn().mockResolvedValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    } as never;
    const file = new File([new Uint8Array(4)], "b.bin");
    await sendZmodemFiles(session, [file]);
    expect((session as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
  });
});
