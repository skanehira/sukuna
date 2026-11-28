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
  it("構造化コメントの列を足しても既存のキューと会話イベントをそのまま読める", () => {
    const home = createTempHome();
    const opened = openDatabase(home);
    try {
      expect(applyMigrations(opened.sqlite, migrations.slice(0, 1)).isOk()).toBe(true);
      opened.sqlite.exec(
        "INSERT INTO conversations (id, project_id, kind, cwd) VALUES ('c', 'p', 'chat', '/work')",
      );
      opened.sqlite.exec(
        "INSERT INTO queued_instructions (id, conversation_id, text, images, position, client_id, created_at) VALUES ('q', 'c', '旧入力', '[\"image\"]', 1, 'client', 10)",
      );
      opened.sqlite
        .prepare(
          "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES ('c', 1, 'user_message', ?, 10)",
        )
        .run(JSON.stringify({ text: "旧発言", images: [], origin: "developer" }));
      expect(applyMigrations(opened.sqlite, migrations).isOk()).toBe(true);
      expect(
        opened.sqlite
          .prepare(
            "SELECT id, conversation_id, text, images, position, client_id, created_at, timeline_comments FROM queued_instructions",
          )
          .all(),
      ).toEqual([
        {
          id: "q",
          conversation_id: "c",
          text: "旧入力",
          images: '["image"]',
          position: 1,
          client_id: "client",
          created_at: 10,
          timeline_comments: null,
        },
      ]);
      expect(opened.sqlite.prepare("SELECT payload FROM conversation_events").all()).toEqual([
        { payload: JSON.stringify({ text: "旧発言", images: [], origin: "developer" }) },
      ]);
    } finally {
      opened.close();
      removeTempHome(home);
    }
  });
  it("相談の範囲を保存する列を追加しても、以前の下書きと預けた相談コメントを保つ", () => {
    const home = createTempHome();
    const opened = openDatabase(home);
    const comments = JSON.stringify([{ task_id: "task", text: "相談本文" }]);
    try {
      expect(applyMigrations(opened.sqlite, migrations.slice(0, 2)).isOk()).toBe(true);
      opened.sqlite.exec(
        "INSERT INTO conversations (id, project_id, kind, cwd) VALUES ('c', 'p', 'chat', '/work')",
      );
      opened.sqlite
        .prepare(
          "INSERT INTO drafts (conversation_id, text, images, updated_at, updated_by) VALUES ('c', '下書き', ?, 20, 'tab')",
        )
        .run(JSON.stringify(["image"]));
      opened.sqlite
        .prepare(
          "INSERT INTO queued_instructions (id, conversation_id, text, images, position, client_id, created_at, timeline_comments) VALUES ('q', 'c', '相談の指示', '[]', 1, 'client', 21, ?)",
        )
        .run(comments);
      expect(applyMigrations(opened.sqlite, migrations).isOk()).toBe(true);
      expect(
        opened.sqlite
          .prepare("SELECT text, images, updated_at, updated_by, timeline_anchors FROM drafts")
          .all(),
      ).toEqual([
        {
          text: "下書き",
          images: '["image"]',
          updated_at: 20,
          updated_by: "tab",
          timeline_anchors: null,
        },
      ]);
      expect(
        opened.sqlite
          .prepare("SELECT text, timeline_comments, timeline_anchors FROM queued_instructions")
          .all(),
      ).toEqual([{ text: "相談の指示", timeline_comments: comments, timeline_anchors: null }]);
    } finally {
      opened.close();
      removeTempHome(home);
    }
  });

  it("複数のストック対応を追加しても既存の単数の対応を保つ", () => {
    const home = createTempHome();
    const opened = openDatabase(home);
    try {
      expect(applyMigrations(opened.sqlite, migrations.slice(0, -1)).isOk()).toBe(true);
      opened.sqlite.exec(
        "INSERT INTO conversations (id, project_id, kind, cwd) VALUES ('c','p','chat','/work');" +
          "INSERT INTO queued_instructions (id, conversation_id, text, position, stock_item_id, created_at) VALUES ('q','c','確認する',1,'stock',10)",
      );
      expect(applyMigrations(opened.sqlite, migrations).isOk()).toBe(true);
      expect(
        opened.sqlite
          .prepare("SELECT text, stock_item_id, delivery_context FROM queued_instructions")
          .get(),
      ).toEqual({
        text: "確認する",
        stock_item_id: "stock",
        delivery_context: null,
      });
    } finally {
      opened.close();
      removeTempHome(home);
    }
  });

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
