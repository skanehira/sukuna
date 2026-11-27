import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createTempHome, removeTempHome } from "../../../../shared/db/test-helpers";
import { createInstallFiles } from "./install-files";

it("隔離した導入先に持ち主だけの領域を作り、再導入で VAPID の鍵を維持する", async () => {
  const fixture = createTempHome();
  try {
    const home = join(fixture, "data");
    mkdirSync(home, { mode: 0o755 });
    mkdirSync(join(home, "logs"), { mode: 0o755 });
    chmodSync(fixture, 0o755);
    writeFileSync(join(home, "sample.db"), "keep");
    const files = createInstallFiles(home, fixture, fixture);
    files.prepare();
    const vapid = join(home, "vapid.json");
    const first = readFileSync(vapid, "utf8");
    const keys = JSON.parse(first) as { publicKey: string; privateKey: string };
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, "base64url")).toHaveLength(32);
    expect(() => createInstallFiles(fixture, fixture, fixture).prepare()).toThrow("利用者のホーム");
    expect(statSync(fixture).mode & 0o777).toBe(0o755);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(home, "sample.db"), "utf8")).toBe("keep");
    expect(statSync(join(home, "backups")).mode & 0o777).toBe(0o700);
    expect(statSync(vapid).mode & 0o777).toBe(0o600);
    files.writePlist("runner", "plist");
    files.prepare();
    expect(readFileSync(vapid, "utf8")).toBe(first);
    expect(readFileSync(files.plistPath("runner"), "utf8")).toBe("plist");
    const runner = join(fixture, "dist", "runner");
    mkdirSync(runner, { recursive: true });
    writeFileSync(join(runner, "main.js"), "first");
    files.writeRunnerHash(await files.runnerHash());
    expect(files.readRunnerHash()).toBe(await files.runnerHash());
    writeFileSync(join(runner, "main.js"), "other");
    expect(files.readRunnerHash()).not.toBe(await files.runnerHash());
  } finally {
    removeTempHome(fixture);
  }
});
