import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  columnNames,
  createTempHome,
  indexesOf,
  openMigratedDatabase,
  removeTempHome,
  tableNames,
  type OpenedDatabase,
} from "./test-helpers";

const expectedColumns: Record<string, string[]> = {
  projects: [
    "id",
    "name",
    "path",
    "uses_github",
    "default_branch",
    "permission_mode",
    "model",
    "design_merge_mode",
    "auto_stages",
    "impl_concurrency",
    "confirm_before_merge_default",
    "flow_paused",
    "removed_at",
  ],
  conversations: [
    "id",
    "project_id",
    "kind",
    "issue_id",
    "parent_conversation_id",
    "title",
    "session_id",
    "cwd",
    "worktree_id",
    "run_state",
    "stop_reason",
    "resets_at",
    "last_seq",
    "last_read_seq",
    "last_position",
    "recap_seq",
    "recap_failed_at",
    "last_activity_at",
    "closed_at",
  ],
  conversation_events: ["conversation_id", "seq", "type", "payload", "sdk_uuid", "created_at"],
  drafts: ["conversation_id", "text", "images", "updated_at", "updated_by", "timeline_anchors"],
  queued_instructions: [
    "id",
    "conversation_id",
    "text",
    "images",
    "position",
    "stock_item_id",
    "client_id",
    "created_at",
    "timeline_comments",
    "timeline_anchors",
  ],
  pending_answers: ["conversation_id", "question_seq", "answers", "updated_at"],
  stock_items: [
    "id",
    "conversation_id",
    "kind",
    "text",
    "quote",
    "state",
    "sent_at",
    "sent_seq",
    "thread_conversation_id",
    "github_comment_url",
  ],
  toc_entries: ["conversation_id", "position", "title", "start_seq"],
  questions: ["id", "conversation_id", "seq", "kind", "text", "answered"],
  issues: [
    "id",
    "project_id",
    "number",
    "title",
    "body",
    "kind",
    "state",
    "stop_reason",
    "parent_id",
    "priority",
    "designed",
    "confirm_before_merge",
    "pr_url",
    "github_number",
    "created_conversation_id",
    "created_at",
    "updated_at",
    "closed_at",
  ],
  issue_dependencies: ["issue_id", "depends_on_id"],
  issue_events: ["issue_id", "seq", "type", "payload", "created_at"],
  worktrees: [
    "id",
    "project_id",
    "path",
    "branch",
    "branch_created",
    "origin",
    "issue_id",
    "port_slot",
    "removed_at",
  ],
  pr_snapshots: ["issue_id", "pr_url", "payload", "fetched_at"],
  notifications: [
    "id",
    "target_kind",
    "target_id",
    "reason",
    "title",
    "body",
    "created_at",
    "dismissed_at",
  ],
  push_subscriptions: ["id", "endpoint", "keys", "user_agent", "created_at"],
  settings: ["key", "value"],
};

const expectedIndexes: {
  table: string;
  columns: string[];
  unique: boolean;
  partial: boolean;
}[] = [
  { table: "conversations", columns: ["project_id", "closed_at"], unique: false, partial: false },
  { table: "conversations", columns: ["issue_id"], unique: false, partial: false },
  { table: "conversations", columns: ["parent_conversation_id"], unique: false, partial: false },
  { table: "issues", columns: ["project_id", "state"], unique: false, partial: false },
  { table: "stock_items", columns: ["conversation_id", "state"], unique: false, partial: false },
  { table: "projects", columns: ["path"], unique: true, partial: false },
  { table: "issues", columns: ["project_id", "number"], unique: true, partial: false },
  { table: "issues", columns: ["project_id", "github_number"], unique: true, partial: true },
  { table: "worktrees", columns: ["project_id", "path"], unique: true, partial: true },
  {
    table: "conversation_events",
    columns: ["conversation_id", "sdk_uuid"],
    unique: true,
    partial: true,
  },
];

describe("データベースのスキーマ", () => {
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

  it("空のデータベースに当てると、DESIGN.md の 17 テーブルと主な列ができる", () => {
    expect(tableNames(opened.sqlite)).toEqual(Object.keys(expectedColumns).sort());
    for (const [table, columns] of Object.entries(expectedColumns)) {
      expect(columnNames(opened.sqlite, table)).toEqual(columns);
    }
    expect(existsSync(join(home, "sukuna.db"))).toBe(true);
  });

  it("DESIGN.md に挙げたインデックスがすべてある", () => {
    for (const expected of expectedIndexes) {
      const matches = indexesOf(opened.sqlite, expected.table).filter(
        (index) =>
          index.unique === expected.unique &&
          index.partial === expected.partial &&
          index.columns.join(",") === expected.columns.join(","),
      );
      expect(matches).toHaveLength(1);
    }
    const primary = indexesOf(opened.sqlite, "conversation_events").find(
      (index) => index.origin === "pk",
    );
    expect(primary?.columns).toEqual(["conversation_id", "seq"]);
  });
});
