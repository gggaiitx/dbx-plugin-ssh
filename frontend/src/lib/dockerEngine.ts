/**
 * Docker/Podman 引擎连接设置（面板齿轮弹层）：容器 CLI 命令与守护进程端点
 * （unix socket / tcp host）三参数的归一、校验与按连接持久化。字段语义与
 * sidecar docker/list|logs|action 的可选 cli/socket/host 参数一一对应：
 * 端点由 sidecar 经 DOCKER_HOST/CONTAINER_HOST 环境变量下发，Docker 与
 * Podman 各取所需，一处设置两个引擎通用。本模块只做纯逻辑与 localStorage，
 * RPC 调用留在 DockerPanel。
 */

export interface DockerEngineSettings {
  /** 容器 CLI：二进制名或全路径；空串 = 默认 docker。 */
  cli: string;
  /** daemon unix socket；空串 = 引擎默认。与 host 互斥。 */
  socket: string;
  /** daemon tcp 端点（如 127.0.0.1:2375）；空串 = 引擎默认。与 socket 互斥。 */
  host: string;
}

export const DEFAULT_DOCKER_CLI = "docker";

/** 与 sidecar 同口径的字符白名单（shell/cmd 双惰性），避免怪字符下探到脚本。 */
export const DOCKER_CLI_PATTERN = /^[A-Za-z0-9_.\\/:/-]{1,256}$/;
export const DOCKER_ENDPOINT_PATTERN = /^[A-Za-z0-9_.\\/:/-]{1,512}$/;

export const DOCKER_ENGINE_STORAGE_PREFIX = "ssh-docker-engine-";

export function dockerEngineStorageKey(connectionKey: string): string {
  return `${DOCKER_ENGINE_STORAGE_PREFIX}${connectionKey || "local"}`;
}

export const EMPTY_DOCKER_ENGINE_SETTINGS: DockerEngineSettings = {
  cli: "",
  socket: "",
  host: "",
};

export interface DockerEngineValidation {
  settings: DockerEngineSettings;
  errors: { cli?: string; endpoints?: string };
}

/** 端点形状与 sidecar normalize_endpoint 同口径：显式 scheme 直通，
 * `/` 开头按 unix socket，含 `:` 按 tcp host:port，其余非法。 */
export function isDockerEndpointShape(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    lower.startsWith("unix://") ||
    lower.startsWith("tcp://") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("npipe:")
  ) {
    return true;
  }
  return value.startsWith("/") || value.includes(":");
}

/**
 * 归一并校验原始输入：trim、字符白名单、端点形状、socket/host 互斥。
 * cli 空串合法（= 默认 docker）；返回的 errors 为空即可保存生效。
 */
export function validateDockerEngineSettings(raw: Partial<DockerEngineSettings>): DockerEngineValidation {
  const cli = (raw.cli ?? "").trim();
  const socket = (raw.socket ?? "").trim();
  const host = (raw.host ?? "").trim();
  const errors: DockerEngineValidation["errors"] = {};
  if (cli && !DOCKER_CLI_PATTERN.test(cli)) {
    errors.cli = "invalid";
  }
  if (socket && host) {
    errors.endpoints = "conflict";
  } else if ((socket && (!DOCKER_ENDPOINT_PATTERN.test(socket) || !isDockerEndpointShape(socket))) || (host && (!DOCKER_ENDPOINT_PATTERN.test(host) || !isDockerEndpointShape(host)))) {
    errors.endpoints = "invalid";
  }
  return { settings: { cli, socket, host }, errors };
}

/** 面板随每次 invoke 携带的附加参数：空串剔除，非空原样透传（归一在 sidecar）。 */
export function dockerEngineParams(settings: DockerEngineSettings): Record<string, string> {
  const params: Record<string, string> = {};
  if (settings.cli) params.cli = settings.cli;
  if (settings.socket) params.socket = settings.socket;
  if (settings.host) params.host = settings.host;
  return params;
}

/** localStorage 读取；损坏/缺失/非法回落（非法字段单独剔除，合法字段保留）。
 *  仅 window 环境可用（面板内调用）。 */
export function loadDockerEngineSettings(connectionKey: string): DockerEngineSettings {
  if (typeof localStorage === "undefined") return { ...EMPTY_DOCKER_ENGINE_SETTINGS };
  try {
    const raw = localStorage.getItem(dockerEngineStorageKey(connectionKey));
    if (!raw) return { ...EMPTY_DOCKER_ENGINE_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY_DOCKER_ENGINE_SETTINGS };
    const record = parsed as Record<string, unknown>;
    const stringOf = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
    const { settings, errors } = validateDockerEngineSettings({
      cli: stringOf("cli"),
      socket: stringOf("socket"),
      host: stringOf("host"),
    });
    // 存量数据可能早于当前校验口径：非法字段剔除而不是让整份设置失效。
    return {
      cli: errors.cli ? "" : settings.cli,
      socket: errors.endpoints ? "" : settings.socket,
      host: errors.endpoints ? "" : settings.host,
    };
  } catch {
    return { ...EMPTY_DOCKER_ENGINE_SETTINGS };
  }
}

export function saveDockerEngineSettings(connectionKey: string, settings: DockerEngineSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(dockerEngineStorageKey(connectionKey), JSON.stringify(settings));
  } catch {
    // 存储不可用（隐私模式等）：设置仅本次会话内存生效。
  }
}
