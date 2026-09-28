// @vitest-environment happy-dom
// 动态补全 provider 注册表（review 第三批地基）：注册/注销/按目标形状挑选。
import { afterEach, describe, expect, it } from "vitest";
import {
  listDynamicCompletionProviders,
  pickDynamicCompletionProvider,
  registerDynamicCompletionProvider,
  unregisterDynamicCompletionProvider,
  type DynamicCompletionProvider,
} from "./provider";

function makeProvider(overrides: Partial<DynamicCompletionProvider> = {}): DynamicCompletionProvider {
  return {
    id: "test-provider",
    label: "test",
    matches: (target, path) => target.kind === "positional" && path[0] === "git",
    complete: async () => ["main", "dev"],
    ...overrides,
  };
}

afterEach(() => {
  for (const provider of listDynamicCompletionProviders()) unregisterDynamicCompletionProvider(provider.id);
});

describe("dynamic completion provider registry", () => {
  it("picks the first provider whose shape matches the request", async () => {
    registerDynamicCompletionProvider(makeProvider());
    const request = { commandPath: ["git", "checkout"], target: { kind: "positional", name: "branch" } as const, prefix: "m" };
    const picked = pickDynamicCompletionProvider(request);
    expect(picked?.id).toBe("test-provider");
    expect(await picked?.complete(request)).toEqual(["main", "dev"]);
  });

  it("returns null when no provider matches the command or target", () => {
    registerDynamicCompletionProvider(makeProvider());
    expect(pickDynamicCompletionProvider({ commandPath: ["kubectl"], target: { kind: "flag-value", flag: "output" }, prefix: "" })).toBeNull();
  });

  it("returns null on an empty registry and unregisters cleanly", () => {
    expect(pickDynamicCompletionProvider({ commandPath: ["git"], target: { kind: "positional", name: "branch" }, prefix: "" })).toBeNull();
    registerDynamicCompletionProvider(makeProvider());
    unregisterDynamicCompletionProvider("test-provider");
    expect(listDynamicCompletionProviders()).toEqual([]);
  });
});
