// @vitest-environment happy-dom
// Fig spec 归一化（review 第三批地基）：长/短名拆分、带值 flag、动态
// positional、两层子命令树截断。
import { describe, expect, it } from "vitest";
import { normalizeFigCommand, type FigCommandInput } from "./figImport";

describe("normalizeFigCommand", () => {
  it("maps fig options to long/short flags with args", () => {
    const input: FigCommandInput = {
      name: "git",
      description: "VCS",
      options: [
        { name: ["--verbose", "-v"], description: "talk more" },
        { name: "--branch", description: "new branch", args: { name: "branch" } },
        { name: ["--color"], args: true },
      ],
    };
    const spec = normalizeFigCommand(input);
    expect(spec.name).toBe("git");
    expect(spec.flags).toEqual([
      { name: "verbose", short: "v", description: "talk more" },
      { name: "branch", description: "new branch", arg: "branch" },
      { name: "color", description: "color", arg: "value" },
    ]);
  });

  it("marks the first required positional as dynamic and recurses subcommands", () => {
    const input: FigCommandInput = {
      name: "gh",
      subcommands: [
        {
          name: "pr",
          subcommands: [
            { name: "checkout", description: "Check out", args: [{ name: "branch" }] },
          ],
        },
      ],
    };
    const spec = normalizeFigCommand(input);
    expect(spec.subcommands?.[0].name).toBe("pr");
    const leaf = spec.subcommands?.[0].subcommands?.[0];
    expect(leaf?.name).toBe("checkout");
    expect(leaf?.positional).toEqual({ name: "branch", dynamic: true });
  });

  it("truncates the subcommand tree beyond two levels", () => {
    const deep: FigCommandInput = {
      name: "l0",
      subcommands: [
        { name: "l1", subcommands: [{ name: "l2", subcommands: [{ name: "l3" }] }] },
      ],
    };
    const spec = normalizeFigCommand(deep);
    const l1 = spec.subcommands?.[0];
    const l2 = l1?.subcommands?.[0];
    // l2 位于第二层：其子命令树被截断（空数组不产出字段）。
    expect(l2?.name).toBe("l2");
    expect(l2?.subcommands).toBeUndefined();
  });
});
