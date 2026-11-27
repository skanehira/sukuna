import { describe, expect, it } from "vite-plus/test";
import { ScriptedGh } from "./scripted-gh";
import { createGhCli } from "../../runner/modules/flow/adapter/gh-cli";
describe("gh の台本", () => {
  it("最初の一致と fallback を返し引数・cwd・stdin を覚える", async () => {
    const fake = new ScriptedGh({
      responses: [
        { match: "^pr view", stdout: "first", exit_code: 0 },
        { match: "pr", stdout: "second", exit_code: 0 },
      ],
      fallback: { stdout: "", stderr: "unknown", exit_code: 1 },
    });
    const gh = createGhCli(fake);
    expect(await gh.run(["pr", "view", "1"], { cwd: "/repo", stdin: "body" })).toEqual({
      stdout: "first",
      stderr: "",
      exitCode: 0,
    });
    expect(await gh.run(["issue", "list"], { cwd: "/repo" })).toEqual({
      stdout: "",
      stderr: "unknown",
      exitCode: 1,
    });
    expect(fake.calls).toEqual([
      { args: ["pr", "view", "1"], cwd: "/repo", stdin: "body" },
      { args: ["issue", "list"], cwd: "/repo" },
    ]);
  });
});
