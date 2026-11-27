import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { reserveRunnerSocket } from "./ipc-socket";
import { createTempHome, removeTempHome } from "../../../../shared/db/test-helpers";
it("残ったソケットへ同時に起動しても待ち受けを取れるランナーは1つだけ", async () => {
  const home = createTempHome();
  const path = join(home, "runner.sock");
  spawnSync(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))",
    path,
  ]);
  const results = await Promise.allSettled([reserveRunnerSocket(path), reserveRunnerSocket(path)]);
  try {
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => r.reason.message)).toEqual([
      "別のランナーが動いています。",
    ]);
  } finally {
    await Promise.all(results.flatMap((r) => (r.status === "fulfilled" ? [r.value.close()] : [])));
    removeTempHome(home);
  }
});
