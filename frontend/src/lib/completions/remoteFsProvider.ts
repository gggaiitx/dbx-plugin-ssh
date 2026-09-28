// 远端文件系统动态补全 provider（review 第三批 14 的第一个真实实现）：
// 数据源是 SFTP 面板**已加载**的当前目录条目（内存缓存，零新增远端调用）——
// 用户在终端 cd/编辑的面板同目录条目即可 Tab 补全。目录与面板当前目录
// 不一致、面板关闭、无条目时一律返回 null（回落 hint + Tab 透传），不会
// 产生错目录的建议，也不引入远端 I/O 开销。更大范围的动态补全（任意目录
// 的 sftp/list、git branch、kubectl resource）待缓存与触发策略设计后续接入。
import type { DynamicCompletionProvider, DynamicCompletionRequest } from "./provider";

export interface RemoteFsProviderState {
  /** SFTP 面板当前目录（规范以 / 结尾）。 */
  currentPath: string;
  /** 该目录已加载的条目；null/空 = 面板未就绪。 */
  entries: ReadonlyArray<{ name: string; kind: string }> | null;
}

export function createRemoteFsProvider(
  getState: () => RemoteFsProviderState | null,
  label = "sftp cwd",
): DynamicCompletionProvider {
  return {
    id: "remote-fs",
    label,
    matches: (target) => target.kind === "positional",
    async complete(request: DynamicCompletionRequest): Promise<string[] | null> {
      const state = getState();
      if (!state || !state.entries?.length) return null;
      const baseDir = normalizeDir(state.currentPath);
      // prefix 含 / 时用户在敲子路径：仅当其目录与面板当前目录一致才处理
      // （跨目录需要远端 sftp/list，属后续缓存策略，本版不做）。
      const slash = request.prefix.lastIndexOf("/");
      const dir = slash >= 0 ? normalizeDir(request.prefix.slice(0, slash + 1)) : baseDir;
      const tail = slash >= 0 ? request.prefix.slice(slash + 1) : request.prefix;
      if (dir !== baseDir) return null;
      const candidates = state.entries
        .filter((entry) => entry.name.startsWith(tail))
        .map((entry) => ({ name: entry.name, suffix: entry.kind === "directory" ? "/" : "" }));
      if (!candidates.length) return null;
      return candidates.map((candidate) => candidate.name + candidate.suffix);
    },
  };
}

/** 目录路径归一：保证以 / 结尾（"/var" 与 "/var/" 视作同目录）。 */
function normalizeDir(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed === "" ? "/" : `${trimmed}/`;
}
