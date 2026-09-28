// @vitest-environment happy-dom
// 远端 fs provider（review 第三批 14 首实现）：仅用 SFTP 面板已加载条目，
// 目录不匹配/面板未就绪/无候选时透传 null；目录候选补 "/" 后缀。
import { describe, expect, it } from "vitest";
import { createRemoteFsProvider, type RemoteFsProviderState } from "./remoteFsProvider";

const state: RemoteFsProviderState = {
  currentPath: "/var/log/",
  entries: [
    { name: "nginx", kind: "directory" },
    { name: "boot.log", kind: "file" },
    { name: "syslog", kind: "file" },
  ],
};

describe("createRemoteFsProvider", () => {
  it("completes names in the panel directory, suffixing directories with /", async () => {
    const provider = createRemoteFsProvider(() => state);
    // 相对名（无 /）：目录 = 面板当前目录。
    expect(await provider.complete({ commandPath: ["cd"], target: { kind: "positional", name: "dir" }, prefix: "s" })).toEqual(["syslog"]);
    // 子路径形态：目录与面板目录一致时也处理。
    expect(await provider.complete({ commandPath: ["cd"], target: { kind: "positional", name: "dir" }, prefix: "/var/log/ng" })).toEqual(["nginx/"]);
  });

  it("passes through when the requested directory differs or the panel is not ready", async () => {
    const provider = createRemoteFsProvider(() => state);
    expect(await provider.complete({ commandPath: ["cd"], target: { kind: "positional", name: "dir" }, prefix: "/etc/ng" })).toBeNull();
    expect(await provider.complete({ commandPath: ["cd"], target: { kind: "positional", name: "dir" }, prefix: "zzz" })).toBeNull();
    expect(await createRemoteFsProvider(() => null).complete({ commandPath: [], target: { kind: "positional", name: "dir" }, prefix: "" })).toBeNull();
    expect(await createRemoteFsProvider(() => ({ currentPath: "/var/log/", entries: [] })).complete({ commandPath: [], target: { kind: "positional", name: "dir" }, prefix: "s" })).toBeNull();
  });

  it("treats the panel path with or without a trailing slash as the same directory", async () => {
    const provider = createRemoteFsProvider(() => ({ currentPath: "/var/log", entries: state.entries }));
    expect(await provider.complete({ commandPath: ["cd"], target: { kind: "positional", name: "dir" }, prefix: "/var/log/bo" })).toEqual(["boot.log"]);
  });
});
