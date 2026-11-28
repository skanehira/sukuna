import { mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createPtySessions } from "./pty-session";
import { terminalDirectoryKey } from "./terminal-jobs";
import { createTempHome, removeTempHome } from "../../../../shared/db/test-helpers";

it("終了対象を固定した後に同じパスへ別の端末を開いても、最初の端末だけが終わる", async () => {
  const root = realpathSync(createTempHome());
  const path = join(root, "issue-1");
  mkdirSync(path);
  const terminals = createPtySessions({ env: { ...process.env, SHELL: "/bin/sh" } });
  const location = { projectId: "project", path, label: "作業場所" };
  const dimensions = { cols: 40, rows: 10, conversationId: null };

  try {
    terminals.open({ ...location, worktreeId: "old" }, dimensions)._unsafeUnwrap();
    const key = terminalDirectoryKey(statSync(path, { bigint: true }));
    const oldTerminal = terminals.prepareCleanup("old", path, key);
    expect(oldTerminal).toBeDefined();

    renameSync(path, join(root, "retired"));
    mkdirSync(path);
    const opened = terminals.open({ ...location, worktreeId: "new" }, dimensions)._unsafeUnwrap();
    const newKey = terminalDirectoryKey(statSync(path, { bigint: true }));
    expect(terminals.prepareCleanup("old", path, key)).toBeUndefined();
    expect(terminals.prepareCleanup("old", path, newKey)).toBeUndefined();
    await oldTerminal!();

    expect(terminals.runningId(join(root, "retired"))).toBeNull();
    expect(terminals.runningId(path)).toBe(opened.id);
  } finally {
    try {
      await terminals.close();
    } finally {
      removeTempHome(root);
    }
  }
});
