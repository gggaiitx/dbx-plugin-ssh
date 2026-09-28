// Fig / Amazon Q completion spec 归一化（review 第三批地基）：社区 spec 仓库
// 的 JSON 形状转成本项目 SpecCommand，作为 build-time 导入的数据源——静态
// spec 不再只靠手填。仅支持 fig schema 的静态子集（name/description/
// options/args/subcommands）；generators、priority、loop 等动态指令忽略
// （对应目标转成 dynamic positional，运行期由 provider/Tab 透传补齐）。
// 纯函数、零依赖；scripts/import-fig-specs.mjs 是它的 CLI 薄包装。

import type { CompletionFlagSpec, SpecCommand } from "./spec";

export interface FigOptionInput {
  /** fig 允许字符串或数组（["--branch", "-b"]，首个长名优先）。 */
  name: string | string[];
  description?: string;
  /** 带值形态：true（无名占位）或 { name: "branch" }；缺省为无参 flag。 */
  args?: { name?: string } | boolean | null;
}

export interface FigArgInput {
  name?: string;
  description?: string;
  isVariadic?: boolean;
  isOptional?: boolean;
}

export interface FigCommandInput {
  name: string;
  description?: string;
  subcommands?: FigCommandInput[];
  options?: FigOptionInput[];
  args?: FigArgInput[];
}

/** 本项目 spec 的子命令树最深两层（根之下再一层）。 */
const MAX_SUBCOMMAND_DEPTH = 2;

function splitOptionNames(names: string | string[]): { long?: string; short?: string } {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  const long = list.find((name) => name.startsWith("--"))?.slice(2);
  const short = list.find((name) => name.startsWith("-") && !name.startsWith("--"))?.slice(1);
  return { long, short };
}

function normalizeOption(option: FigOptionInput): CompletionFlagSpec | null {
  const { long, short } = splitOptionNames(option.name);
  const name = long ?? short;
  if (!name) return null;
  // args: true → 无名占位；{ name } → 具名占位；false/null/缺省 → 无参 flag。
  const argSpec = option.args;
  const hasArg = argSpec === true || (argSpec !== null && argSpec !== false && typeof argSpec === "object");
  const argName = typeof argSpec === "object" && argSpec !== null ? argSpec.name ?? "value" : "value";
  return {
    name,
    ...(short !== undefined ? { short } : {}),
    description: option.description ?? name,
    ...(hasArg ? { arg: argName } : {}),
  };
}

/** fig 单条命令 → SpecCommand；depth 供子命令树截断（本 spec 最深两层）。 */
export function normalizeFigCommand(input: FigCommandInput, depth = 0): SpecCommand {
  const flags = (input.options ?? [])
    .map(normalizeOption)
    .filter((flag): flag is CompletionFlagSpec => flag !== null);
  const positional = input.args?.find((arg) => !arg.isOptional);
  const subcommands = depth < MAX_SUBCOMMAND_DEPTH
    ? (input.subcommands ?? []).map((sub) => normalizeFigCommand(sub, depth + 1))
    : [];
  return {
    name: input.name,
    description: input.description || input.name,
    ...(subcommands.length ? { subcommands } : {}),
    ...(flags.length ? { flags } : {}),
    ...(positional
      ? { positional: { name: positional.name ?? "arg", dynamic: true } }
      : {}),
  };
}
