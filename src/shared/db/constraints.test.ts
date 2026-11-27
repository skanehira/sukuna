import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "./test-helpers";

function constraintCode(action: () => void): string {
  try {
    action();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== undefined) return code;
    throw error;
  }
  throw new Error("制約に違反しませんでした");
}

function countRows(
  sqlite: Database.Database,
  table: string,
  where = "1 = 1",
  ...params: (string | number | null)[]
): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(...params) as {
    count: number;
  };
  return row.count;
}

function insertProject(sqlite: Database.Database, id: string, path: string): void {
  sqlite
    .prepare("INSERT INTO projects (id, name, path, default_branch) VALUES (?, ?, ?, ?)")
    .run(id, id, path, "main");
}

function insertConversation(sqlite: Database.Database, id: string, projectId = "p1"): void {
  sqlite
    .prepare("INSERT INTO conversations (id, project_id, kind, cwd) VALUES (?, ?, ?, ?)")
    .run(id, projectId, "chat", "/repo");
}

function insertConversationEvent(
  sqlite: Database.Database,
  conversationId: string,
  seq: number,
  sdkUuid: string | null,
): void {
  sqlite
    .prepare(
      "INSERT INTO conversation_events (conversation_id, seq, type, payload, sdk_uuid, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(conversationId, seq, "user_message", "{}", sdkUuid, 1);
}

function insertIssue(
  sqlite: Database.Database,
  id: string,
  projectId: string,
  number: number,
  options: {
    githubNumber?: number | null;
    createdConversationId?: string | null;
    parentId?: string | null;
  } = {},
): void {
  sqlite
    .prepare(
      "INSERT INTO issues (id, project_id, number, title, body, state, github_number, created_conversation_id, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      projectId,
      number,
      id,
      "",
      "draft",
      options.githubNumber ?? null,
      options.createdConversationId ?? null,
      options.parentId ?? null,
      1,
      1,
    );
}

function insertIssueDependency(
  sqlite: Database.Database,
  issueId: string,
  dependsOnId: string,
): void {
  sqlite
    .prepare("INSERT INTO issue_dependencies (issue_id, depends_on_id) VALUES (?, ?)")
    .run(issueId, dependsOnId);
}

function insertIssueEvent(sqlite: Database.Database, issueId: string, seq: number): void {
  sqlite
    .prepare(
      "INSERT INTO issue_events (issue_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(issueId, seq, "created", "{}", 1);
}

function insertWorktree(
  sqlite: Database.Database,
  id: string,
  projectId: string,
  path: string,
  removedAt: number | null,
): void {
  sqlite
    .prepare(
      "INSERT INTO worktrees (id, project_id, path, branch, origin, removed_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, projectId, path, `branch-${id}`, "user", removedAt);
}

function seedConversationChildren(
  sqlite: Database.Database,
  conversationId: string,
  suffix: string,
): void {
  insertConversationEvent(sqlite, conversationId, 1, null);
  sqlite
    .prepare(
      "INSERT INTO drafts (conversation_id, text, updated_at, updated_by) VALUES (?, ?, ?, ?)",
    )
    .run(conversationId, "書きかけ", 1, "tab");
  sqlite
    .prepare(
      "INSERT INTO queued_instructions (id, conversation_id, text, position, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(`queued-${suffix}`, conversationId, "預けたい指示", 1, 1);
  sqlite
    .prepare(
      "INSERT INTO pending_answers (conversation_id, question_seq, answers, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(conversationId, 1, "{}", 1);
  sqlite
    .prepare(
      "INSERT INTO stock_items (id, conversation_id, kind, text, state) VALUES (?, ?, ?, ?, ?)",
    )
    .run(`stock-${suffix}`, conversationId, "question", "ストック", "stocked");
  sqlite
    .prepare(
      "INSERT INTO toc_entries (conversation_id, position, title, start_seq) VALUES (?, ?, ?, ?)",
    )
    .run(conversationId, 1, "章", 1);
  sqlite
    .prepare("INSERT INTO questions (id, conversation_id, seq, kind, text) VALUES (?, ?, ?, ?, ?)")
    .run(`question-${suffix}`, conversationId, 1, "text", "質問");
}

const conversationChildTables = [
  "conversation_events",
  "drafts",
  "queued_instructions",
  "pending_answers",
  "stock_items",
  "toc_entries",
  "questions",
];

describe("データベースの制約", () => {
  let home: string;
  let opened: OpenedDatabase;

  beforeEach(() => {
    home = createTempHome();
    opened = openMigratedDatabase(home);
  });

  afterEach(() => {
    opened.close();
    removeTempHome(home);
  });

  it("projects の path が重なる行は追加できない", () => {
    insertProject(opened.sqlite, "p1", "/repo/a");

    expect(constraintCode(() => insertProject(opened.sqlite, "p2", "/repo/a"))).toBe(
      "SQLITE_CONSTRAINT_UNIQUE",
    );
    insertProject(opened.sqlite, "p3", "/repo/b");

    expect(countRows(opened.sqlite, "projects")).toBe(2);
  });

  it("同じプロジェクトで issues の number が重なる行は追加できない", () => {
    insertProject(opened.sqlite, "p1", "/repo/a");
    insertProject(opened.sqlite, "p2", "/repo/b");
    insertIssue(opened.sqlite, "i1", "p1", 1);

    expect(constraintCode(() => insertIssue(opened.sqlite, "i2", "p1", 1))).toBe(
      "SQLITE_CONSTRAINT_UNIQUE",
    );
    insertIssue(opened.sqlite, "i3", "p2", 1);

    expect(countRows(opened.sqlite, "issues")).toBe(2);
  });

  it("issues の github_number は値がある行どうしだけが重ならない", () => {
    insertProject(opened.sqlite, "p1", "/repo/a");
    insertProject(opened.sqlite, "p2", "/repo/b");
    insertIssue(opened.sqlite, "i1", "p1", 1, { githubNumber: 42 });

    expect(
      constraintCode(() => insertIssue(opened.sqlite, "i2", "p1", 2, { githubNumber: 42 })),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
    insertIssue(opened.sqlite, "i3", "p1", 3, { githubNumber: null });
    insertIssue(opened.sqlite, "i4", "p1", 4, { githubNumber: null });
    insertIssue(opened.sqlite, "i5", "p2", 1, { githubNumber: 42 });

    expect(countRows(opened.sqlite, "issues")).toBe(4);
  });

  it("worktrees は removed_at が空の行どうしだけが重ならない", () => {
    insertProject(opened.sqlite, "p1", "/repo/a");
    insertProject(opened.sqlite, "p2", "/repo/b");
    insertWorktree(opened.sqlite, "w1", "p1", "/repo/a/.worktrees/issue-1", null);

    expect(
      constraintCode(() =>
        insertWorktree(opened.sqlite, "w2", "p1", "/repo/a/.worktrees/issue-1", null),
      ),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE");
    insertWorktree(opened.sqlite, "w3", "p1", "/repo/a/.worktrees/issue-1", 1);
    insertWorktree(opened.sqlite, "w4", "p1", "/repo/a/.worktrees/issue-1", 2);
    insertWorktree(opened.sqlite, "w5", "p2", "/repo/a/.worktrees/issue-1", null);

    expect(countRows(opened.sqlite, "worktrees")).toBe(4);
  });

  it("conversation_events の sdk_uuid は値がある行どうしだけが重ならない", () => {
    insertConversation(opened.sqlite, "c1");
    insertConversation(opened.sqlite, "c2");
    insertConversationEvent(opened.sqlite, "c1", 1, "uuid-a");

    expect(constraintCode(() => insertConversationEvent(opened.sqlite, "c1", 2, "uuid-a"))).toBe(
      "SQLITE_CONSTRAINT_UNIQUE",
    );
    insertConversationEvent(opened.sqlite, "c1", 3, null);
    insertConversationEvent(opened.sqlite, "c1", 4, null);
    insertConversationEvent(opened.sqlite, "c2", 1, "uuid-a");

    expect(countRows(opened.sqlite, "conversation_events")).toBe(4);
  });

  it("会話を消すと、そのイベント・書きかけ・届く前の指示・送る前の回答・ストック・目次・質問の行が消える", () => {
    insertProject(opened.sqlite, "p1", "/repo/a");
    insertConversation(opened.sqlite, "c1");
    insertConversation(opened.sqlite, "c2");
    seedConversationChildren(opened.sqlite, "c1", "one");
    seedConversationChildren(opened.sqlite, "c2", "two");

    opened.sqlite.exec("DELETE FROM conversations WHERE id = 'c1'");

    for (const table of conversationChildTables) {
      expect(countRows(opened.sqlite, table, "conversation_id = ?", "c1")).toBe(0);
      expect(countRows(opened.sqlite, table, "conversation_id = ?", "c2")).toBe(1);
    }
  });

  it("issue を消すと、その依存と記録の行が消える", () => {
    insertProject(opened.sqlite, "p1", "/repo/a");
    insertIssue(opened.sqlite, "i1", "p1", 1);
    insertIssue(opened.sqlite, "i2", "p1", 2);
    insertIssue(opened.sqlite, "i3", "p1", 3);
    insertIssueDependency(opened.sqlite, "i1", "i2");
    insertIssueDependency(opened.sqlite, "i2", "i1");
    insertIssueDependency(opened.sqlite, "i2", "i3");
    insertIssueEvent(opened.sqlite, "i1", 1);
    insertIssueEvent(opened.sqlite, "i2", 1);

    opened.sqlite.exec("DELETE FROM issues WHERE id = 'i1'");

    expect(
      opened.sqlite
        .prepare(
          "SELECT issue_id, depends_on_id FROM issue_dependencies ORDER BY issue_id, depends_on_id",
        )
        .all(),
    ).toEqual([{ issue_id: "i2", depends_on_id: "i3" }]);
    expect(
      opened.sqlite.prepare("SELECT issue_id, seq FROM issue_events ORDER BY issue_id, seq").all(),
    ).toEqual([{ issue_id: "i2", seq: 1 }]);
    expect(opened.sqlite.prepare("SELECT id FROM issues ORDER BY id").all()).toEqual([
      { id: "i2" },
      { id: "i3" },
    ]);
  });

  it("残す参照の先を消しても、参照する行は残る", () => {
    insertProject(opened.sqlite, "p1", "/repo/a");
    insertConversation(opened.sqlite, "c1");
    insertConversation(opened.sqlite, "c2");
    insertConversation(opened.sqlite, "c3");
    insertConversation(opened.sqlite, "c4");
    insertWorktree(opened.sqlite, "w1", "p1", "/repo/a/.worktrees/issue-1", null);
    insertIssue(opened.sqlite, "i1", "p1", 1, { createdConversationId: "c1" });
    insertIssue(opened.sqlite, "i2", "p1", 2, { parentId: "i1" });
    opened.sqlite.prepare("UPDATE conversations SET worktree_id = 'w1' WHERE id = 'c3'").run();
    opened.sqlite.prepare("UPDATE conversations SET issue_id = 'i1' WHERE id = 'c4'").run();
    opened.sqlite
      .prepare(
        "INSERT INTO stock_items (id, conversation_id, kind, text, state) VALUES (?, ?, ?, ?, ?)",
      )
      .run("stock-1", "c2", "question", "ストック", "stocked");
    opened.sqlite
      .prepare("UPDATE stock_items SET thread_conversation_id = 'c1' WHERE id = 'stock-1'")
      .run();

    opened.sqlite.exec("DELETE FROM conversations WHERE id = 'c1'");

    expect(
      opened.sqlite.prepare("SELECT id, created_conversation_id FROM issues WHERE id = 'i1'").get(),
    ).toEqual({ id: "i1", created_conversation_id: "c1" });
    expect(
      opened.sqlite
        .prepare("SELECT id, thread_conversation_id FROM stock_items WHERE id = 'stock-1'")
        .get(),
    ).toEqual({ id: "stock-1", thread_conversation_id: "c1" });

    opened.sqlite.exec("DELETE FROM worktrees WHERE id = 'w1'");

    expect(
      opened.sqlite.prepare("SELECT id, worktree_id FROM conversations WHERE id = 'c3'").get(),
    ).toEqual({ id: "c3", worktree_id: "w1" });

    opened.sqlite.exec("DELETE FROM issues WHERE id = 'i1'");

    expect(
      opened.sqlite.prepare("SELECT id, issue_id FROM conversations WHERE id = 'c4'").get(),
    ).toEqual({ id: "c4", issue_id: "i1" });
    expect(opened.sqlite.prepare("SELECT id, parent_id FROM issues WHERE id = 'i2'").get()).toEqual(
      {
        id: "i2",
        parent_id: "i1",
      },
    );
  });
});
