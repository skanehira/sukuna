import type Database from "better-sqlite3";
import { describe, expect, it } from "vite-plus/test";
import { applyMigrations, migrations, type Migration } from "./migrate";
import { openDatabase } from "./open";
import { createTempHome, openMigratedDatabase, removeTempHome, tableNames } from "./test-helpers";

function countMigrations(sqlite: Database.Database): number {
  const row = sqlite.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as {
    count: number;
  };
  return row.count;
}

describe("マイグレーション", () => {
  it("当て済みのデータベースにもう一度当てても、何も変わらない", () => {
    const home = createTempHome();
    const opened = openMigratedDatabase(home);

    try {
      opened.sqlite
        .prepare("INSERT INTO projects (id, name, path, default_branch) VALUES (?, ?, ?, ?)")
        .run("p1", "プロジェクト", "/repo", "main");
      const before = {
        tables: tableNames(opened.sqlite),
        migrations: countMigrations(opened.sqlite),
      };

      const result = applyMigrations(opened.sqlite, migrations);

      expect(result.isOk()).toBe(true);
      expect({
        tables: tableNames(opened.sqlite),
        migrations: countMigrations(opened.sqlite),
      }).toEqual(before);
      expect(opened.sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({
        count: 1,
      });
    } finally {
      opened.close();
      removeTempHome(home);
    }
  });

  it("わざと失敗するマイグレーションを当てると、ロールバックされる", () => {
    const home = createTempHome();
    const opened = openDatabase(home);
    const broken: Migration[] = [
      {
        tag: "0000_broken",
        when: 1,
        statements: ["CREATE TABLE broken (id text)", "CREATE TABLE broken (id text)"],
        hash: "broken",
      },
    ];

    try {
      const result = applyMigrations(opened.sqlite, broken);

      expect(result.isErr()).toBe(true);
      expect(tableNames(opened.sqlite)).toEqual([]);
      expect(
        opened.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      opened.close();
      removeTempHome(home);
    }
  });
});
