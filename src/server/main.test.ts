import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createTempHome, removeTempHome } from "../shared/db/test-helpers";
import { xdgVariablesIn } from "../test/directories";
it.each([
  [{ NODE_ENV: "production", SUKUNA_GH: "/unused.json" }, "本番では SUKUNA_GH を指定できません。"],
  [
    { SUKUNA_RUNNER_SOCKET: "/" + "x".repeat(103) },
    "SUKUNA_RUNNER_SOCKET は 103 バイト以内で指定してください。",
  ],
] as const)(
  "サーバーの起動で無効な環境変数なら理由を記録して失敗する: %j",
  async (env, message) => {
    const home = createTempHome();
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {createServer}from'vite';const s=await createServer({configFile:false,root:process.cwd(),define:{__SUKUNA_BUILD_ID__:JSON.stringify('test')},server:{middlewareMode:true,ws:false,watch:null},optimizeDeps:{entries:[]}});await s.ssrLoadModule('/src/server/main.ts');`,
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: {
          ...process.env,
          NODE_ENV: "development",
          PORT: "5180",
          ...xdgVariablesIn(home),
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    const messages: unknown[] = [];
    const result = await new Promise<number | null>((resolve) => {
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line) as { message: string };
          messages.push(value.message);
          if (value.message.startsWith("listening on")) child.kill("SIGTERM");
        } catch {}
      });
      child.once("exit", resolve);
    });
    try {
      expect({ exit: result, messages }).toEqual({ exit: 1, messages: [message] });
    } finally {
      lines.close();
      removeTempHome(home);
    }
  },
  10000,
);
