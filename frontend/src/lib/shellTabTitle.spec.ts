// shellTabTitle 单测：shell 程序路径 → 本地终端 tab 标题（basename、去 .exe、保留大小写）。
import { describe, expect, it } from "vitest";
import { shellTabTitle } from "./shellTabTitle";

describe("shellTabTitle", () => {
  it("keeps bare program names as-is", () => {
    expect(shellTabTitle("zsh")).toBe("zsh");
    expect(shellTabTitle("bash")).toBe("bash");
    expect(shellTabTitle("pwsh")).toBe("pwsh");
  });

  it("takes the basename of unix-style paths", () => {
    expect(shellTabTitle("/bin/zsh")).toBe("zsh");
    expect(shellTabTitle("/usr/local/bin/fish")).toBe("fish");
  });

  it("takes the basename of windows-style paths", () => {
    expect(shellTabTitle("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
    expect(shellTabTitle("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh");
  });

  it("strips a trailing .exe from bare names", () => {
    expect(shellTabTitle("powershell.exe")).toBe("powershell");
  });

  it("keeps the original casing", () => {
    expect(shellTabTitle("/opt/homebrew/bin/Elvish")).toBe("Elvish");
  });
});
