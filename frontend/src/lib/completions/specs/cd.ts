// cd：远端 fs 动态补全的锚点命令（review 第三批 14）。位置参数标记 dynamic：
// spec 只出占位 hint，真实候选由注册的 remote-fs provider 提供（SFTP 面板
// 已加载条目）；未注册时 Tab 透传远程 shell 自身补全。
import type { SpecCommand } from "../spec";

export const cdSpec: SpecCommand = {
  name: "cd",
  description: "Change the shell working directory",
  positional: { name: "dir", dynamic: true },
};
