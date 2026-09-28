import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOCKER_CLI,
  dockerEngineParams,
  dockerEngineStorageKey,
  EMPTY_DOCKER_ENGINE_SETTINGS,
  loadDockerEngineSettings,
  saveDockerEngineSettings,
  validateDockerEngineSettings,
} from "./dockerEngine";

/** vitest node 环境没有 localStorage：Map 后备实现 stub 全局。 */
function stubLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => backing.delete(key),
  });
  return backing;
}

describe("validateDockerEngineSettings", () => {
  it("trims input and keeps empty cli legal (default docker)", () => {
    const { settings, errors } = validateDockerEngineSettings({ cli: "  ", socket: "", host: "" });
    expect(settings).toEqual({ cli: "", socket: "", host: "" });
    expect(errors).toEqual({});
    expect(DEFAULT_DOCKER_CLI).toBe("docker");
  });

  it("accepts podman names, full paths and both endpoint shapes", () => {
    expect(validateDockerEngineSettings({ cli: "podman", socket: "", host: "" }).errors).toEqual({});
    expect(
      validateDockerEngineSettings({ cli: "/usr/local/bin/podman", socket: "/run/user/1000/podman.sock", host: "" })
        .errors,
    ).toEqual({});
    expect(validateDockerEngineSettings({ cli: "", socket: "", host: "127.0.0.1:2375" }).errors).toEqual({});
  });

  it("rejects shell metacharacters in cli", () => {
    const { errors } = validateDockerEngineSettings({ cli: "docker; rm -rf /", socket: "", host: "" });
    expect(errors.cli).toBe("invalid");
  });

  it("rejects malformed endpoints", () => {
    expect(validateDockerEngineSettings({ cli: "", socket: "unix:///a b.sock", host: "" }).errors.endpoints).toBe(
      "invalid",
    );
    expect(validateDockerEngineSettings({ cli: "", socket: "", host: "no-port-here" }).errors.endpoints).toBe(
      "invalid",
    );
  });

  it("enforces socket/host exclusivity", () => {
    const { errors } = validateDockerEngineSettings({
      cli: "",
      socket: "/run/podman.sock",
      host: "127.0.0.1:2375",
    });
    expect(errors.endpoints).toBe("conflict");
  });
});

describe("dockerEngineParams", () => {
  it("drops empty fields so legacy calls stay untouched", () => {
    expect(dockerEngineParams({ cli: "", socket: "", host: "" })).toEqual({});
    expect(dockerEngineParams({ cli: "podman", socket: "", host: "" })).toEqual({ cli: "podman" });
    expect(dockerEngineParams({ cli: "podman", socket: "/run/podman.sock", host: "" })).toEqual({
      cli: "podman",
      socket: "/run/podman.sock",
    });
  });
});

describe("localStorage persistence", () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keys settings per connection with a local fallback", () => {
    expect(dockerEngineStorageKey("conn-1")).toBe("ssh-docker-engine-conn-1");
    expect(dockerEngineStorageKey("")).toBe("ssh-docker-engine-local");
  });

  it("round-trips saved settings and validates on load", () => {
    saveDockerEngineSettings("conn-1", { cli: "podman", socket: "", host: "127.0.0.1:2375" });
    expect(loadDockerEngineSettings("conn-1")).toEqual({ cli: "podman", socket: "", host: "127.0.0.1:2375" });
    // 损坏 JSON 回落全空；非法字段在读取侧同样被过滤。
    localStorage.setItem("ssh-docker-engine-broken", "{not json");
    expect(loadDockerEngineSettings("broken")).toEqual(EMPTY_DOCKER_ENGINE_SETTINGS);
    localStorage.setItem(
      "ssh-docker-engine-evil",
      JSON.stringify({ cli: 42, socket: "/ok.sock", host: "evil; host" }),
    );
    // socket/host 同时存在触发互斥校验：两者一并剔除（无法判定保谁）。
    expect(loadDockerEngineSettings("evil")).toEqual({ cli: "", socket: "", host: "" });
  });

  it("falls back to empty settings for unknown connections", () => {
    expect(loadDockerEngineSettings("never-saved")).toEqual(EMPTY_DOCKER_ENGINE_SETTINGS);
  });
});
