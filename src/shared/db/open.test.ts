import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openDatabase } from "./open";
import { createTempHome, removeTempHome } from "./test-helpers";
import { directoriesIn } from "../../test/directories";

describe("データベースを開く", () => {
  it("接続の設定で journal_mode が WAL、busy_timeout が 5000、foreign_keys が ON になる", () => {
    const home = createTempHome();
    const opened = openDatabase(directoriesIn(home));

    try {
      expect(opened.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(opened.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(opened.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(existsSync(join(home, "sukuna.db"))).toBe(true);
    } finally {
      opened.close();
      removeTempHome(home);
    }
  });
});
