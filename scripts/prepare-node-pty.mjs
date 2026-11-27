import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const folder of [`prebuilds/darwin-${process.arch}`, "build/Release", "build/Debug"]) {
    const path = join(root, folder, "spawn-helper");
    const file = statSync(path, { throwIfNoEntry: false });
    if (file?.isFile()) chmodSync(path, file.mode | 0o111);
  }
}
