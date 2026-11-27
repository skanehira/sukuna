import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createWorktreeActivity } from "./sqlite-worktree-activity";

it("別プロセスから同じ worktree を拒み、別 worktree・再入・解放後の再取得を許可する", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "sukuna-worktree-lease-")));
  const databasePath = join(home, "sukuna.db");
  const modulePath = fileURLToPath(new URL("./sqlite-worktree-activity.ts", import.meta.url));
  const child = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
    import { registerHooks } from 'node:module';
    import { existsSync } from 'node:fs';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    registerHooks({resolve(specifier, context, next) {
      if (specifier.startsWith('.') && context.parentURL) {
        const candidate = new URL(specifier, context.parentURL);
        if (existsSync(fileURLToPath(candidate) + '.ts')) return next(candidate.href + '.ts', context);
      }
      return next(specifier, context);
    }});
    const {createWorktreeActivity} = await import(pathToFileURL(process.argv[1]).href);
    const activity = createWorktreeActivity(process.argv[2]);
    const same = activity.acquire(['w']);
    const other = activity.acquire(['other']);
    console.log(JSON.stringify({same: same.isOk(), other: other.isOk()}));
    if (same.isOk()) same.value.release();
    if (other.isOk()) other.value.release();
  `,
          modulePath,
          databasePath,
        ],
        { encoding: "utf8" },
      ),
    );
  try {
    const activity = createWorktreeActivity(databasePath);
    const lease = activity.acquire(["w"])._unsafeUnwrap();
    try {
      lease.acquire(["w"]);
      expect(child()).toEqual({ same: false, other: true });
    } finally {
      lease.release();
    }
    expect(child()).toEqual({ same: true, other: true });
    expect(() =>
      activity.run((reservation) => {
        reservation.acquire(["w"]);
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(child()).toEqual({ same: true, other: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
