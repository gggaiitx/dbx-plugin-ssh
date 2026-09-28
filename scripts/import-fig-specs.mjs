#!/usr/bin/env node
// Fig / Amazon Q completion spec 导入器（review 第三批地基）。
//
// 把社区 completion spec 的 JSON 归一化为本项目的 SpecCommand 模块：
//   node scripts/import-fig-specs.mjs <fig-spec.json> [更多.json ...]
//
// 输出写入 frontend/src/lib/completions/specs/imported-<name>.ts，
// 随后在 frontend/src/lib/completions/specs/index.ts 手动聚合进
// COMPLETION_SPECS（导入的 spec 作为原型，review 后可裁剪）。
// 依赖 node ≥22.18 的原生 type stripping（直接 import .ts 纯函数）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const { normalizeFigCommand } = await import(resolve(scriptDir, "../frontend/src/lib/completions/figImport.ts"));

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("用法: node scripts/import-fig-specs.mjs <fig-spec.json> [...]");
  process.exit(1);
}

const outDir = resolve(scriptDir, "../frontend/src/lib/completions/specs");
let imported = 0;
for (const path of inputs) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const spec = normalizeFigCommand(raw);
  if (!spec.name) {
    console.error(`跳过（无 name）: ${path}`);
    continue;
  }
  const file = resolve(outDir, `imported-${spec.name}.ts`);
  const body = [
    `// 由 scripts/import-fig-specs.mjs 从 ${path} 导入（fig/Amazon Q spec 原型，review 后可裁剪）`,
    'import type { SpecCommand } from "../spec";',
    "",
    `export const ${moduleConstName(spec.name)}: SpecCommand = ${JSON.stringify(spec, null, 2)};`,
    "",
  ].join("\n");
  writeFileSync(file, body);
  console.log(`✓ ${spec.name} → ${file}`);
  console.log(`  记得在 specs/index.ts 聚合: import { ${moduleConstName(spec.name)} } from "./imported-${spec.name}";`);
  imported += 1;
}
console.log(`导入完成：${imported} 个 spec`);

function moduleConstName(name) {
  const camel = name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
  return `imported${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}
