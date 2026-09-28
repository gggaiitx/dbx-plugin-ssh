// 动态补全 provider 接口（review 第三批地基）：静态 spec 只覆盖子命令/flag/
// 枚举值；分支名、文件路径、pod 名等本地不可枚举的值此前只出占位 hint 并把
// Tab 透传给远程 shell（shell 是最后一级 provider）。本模块定义可插拔的
// 动态 provider：注册后 hint 层会异步询问 provider，返回的候选替换 hint 行
// 展示；未注册或 provider 返回 null 时保持现行为（hint + Tab 透传），零回归。
// 远端实现（SFTP readdir / git branch / kubectl get 等）按此接口后续接入。

export type DynamicCompletionTarget =
  | { kind: "positional"; name: string }
  | { kind: "flag-value"; flag: string };

export interface DynamicCompletionRequest {
  /** 解析到的命令节点路径（如 ["git", "checkout"]）。 */
  commandPath: string[];
  target: DynamicCompletionTarget;
  /** 当前已敲的值前缀（空串表示值待输入）。 */
  prefix: string;
}

export interface DynamicCompletionProvider {
  id: string;
  /** 候选来源标签（展示在描述里，如 "remote fs"）。 */
  label: string;
  /** 声明是否处理该目标形状（provider 自行按 commandPath 过滤）。 */
  matches(target: DynamicCompletionTarget, commandPath: string[]): boolean;
  /**
   * 返回候选列表；返回 null 表示本次不处理（保持 hint + Tab 透传）。
   * 实现自行负责超时与失败降级（抛错视同 null）。
   */
  complete(request: DynamicCompletionRequest): Promise<string[] | null>;
}

const registry = new Map<string, DynamicCompletionProvider>();

export function registerDynamicCompletionProvider(provider: DynamicCompletionProvider): void {
  registry.set(provider.id, provider);
}

export function unregisterDynamicCompletionProvider(id: string): void {
  registry.delete(id);
}

export function listDynamicCompletionProviders(): DynamicCompletionProvider[] {
  return [...registry.values()];
}

/** 为一条 hint 层匹配挑选 provider：第一个声明处理该目标形状的命中。 */
export function pickDynamicCompletionProvider(request: DynamicCompletionRequest): DynamicCompletionProvider | null {
  for (const provider of registry.values()) {
    if (provider.matches(request.target, request.commandPath)) return provider;
  }
  return null;
}
