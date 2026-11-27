import { sql } from "drizzle-orm";
import type { IssueState, IssueStopReason } from "../issue/state";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

type AutoStage = "triage" | "design" | "impl";
type ConversationKind = "chat" | "triage" | "design" | "impl" | "thread";
type ConversationRunState =
  | "idle"
  | "working"
  | "waiting_answer"
  | "waiting_permission"
  | "stopped"
  | "failed"
  | "usage_limited";
type ConversationStopReason =
  | "user"
  | "restarted"
  | "api_error"
  | "error"
  | "credits_required"
  | "usage_limit";
type StockKind = "question" | "instruction";
type StockState = "stocked" | "sent" | "cancelled";
type QuestionKind = "choice" | "text";
type IssueKind = "bug" | "enhancement" | "refactoring" | "question";
type IssuePriority = "high" | "medium" | "low";
type WorktreeOrigin = "user" | "flow";
type PermissionMode = "bypassPermissions" | "acceptEdits" | "default";
type Model = "opus" | "sonnet" | "haiku";
type DesignMergeMode = "direct" | "pr";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    path: text("path").notNull(),
    usesGithub: integer("uses_github", { mode: "boolean" }).notNull().default(false),
    defaultBranch: text("default_branch").notNull(),
    permissionMode: text("permission_mode")
      .$type<PermissionMode>()
      .notNull()
      .default("bypassPermissions"),
    model: text("model").$type<Model>(),
    designMergeMode: text("design_merge_mode").$type<DesignMergeMode>().notNull().default("direct"),
    autoStages: text("auto_stages", { mode: "json" })
      .$type<AutoStage[]>()
      .notNull()
      .default(sql`'["triage","design","impl"]'`),
    implConcurrency: integer("impl_concurrency").notNull().default(5),
    confirmBeforeMergeDefault: integer("confirm_before_merge_default", { mode: "boolean" })
      .notNull()
      .default(false),
    flowPaused: integer("flow_paused", { mode: "boolean" }).notNull().default(false),
    removedAt: integer("removed_at"),
  },
  (table) => [uniqueIndex("projects_path_unique").on(table.path)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    kind: text("kind").$type<ConversationKind>().notNull(),
    issueId: text("issue_id"),
    parentConversationId: text("parent_conversation_id"),
    title: text("title"),
    sessionId: text("session_id"),
    cwd: text("cwd").notNull(),
    worktreeId: text("worktree_id"),
    runState: text("run_state").$type<ConversationRunState>().notNull().default("idle"),
    stopReason: text("stop_reason").$type<ConversationStopReason>(),
    resetsAt: integer("resets_at"),
    lastSeq: integer("last_seq").notNull().default(0),
    lastReadSeq: integer("last_read_seq").notNull().default(0),
    lastPosition: integer("last_position"),
    recapSeq: integer("recap_seq").notNull().default(0),
    recapFailedAt: integer("recap_failed_at"),
    lastActivityAt: integer("last_activity_at"),
    closedAt: integer("closed_at"),
  },
  (table) => [
    index("conversations_project_id_closed_at_index").on(table.projectId, table.closedAt),
    index("conversations_issue_id_index").on(table.issueId),
    index("conversations_parent_conversation_id_index").on(table.parentConversationId),
  ],
);

export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    sdkUuid: text("sdk_uuid"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.seq] }),
    uniqueIndex("conversation_events_conversation_id_sdk_uuid_unique")
      .on(table.conversationId, table.sdkUuid)
      .where(sql`${table.sdkUuid} is not null`),
  ],
);

export const drafts = sqliteTable("drafts", {
  conversationId: text("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  images: text("images", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").notNull(),
});

export const queuedInstructions = sqliteTable("queued_instructions", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  images: text("images", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  position: integer("position").notNull(),
  stockItemId: text("stock_item_id"),
  clientId: text("client_id"),
  createdAt: integer("created_at").notNull(),
});

export const pendingAnswers = sqliteTable(
  "pending_answers",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    questionSeq: integer("question_seq").notNull(),
    answers: text("answers", { mode: "json" }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.questionSeq] })],
);

export const stockItems = sqliteTable(
  "stock_items",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<StockKind>().notNull(),
    text: text("text").notNull(),
    quote: text("quote"),
    state: text("state").$type<StockState>().notNull(),
    sentAt: integer("sent_at"),
    sentSeq: integer("sent_seq"),
    threadConversationId: text("thread_conversation_id"),
    githubCommentUrl: text("github_comment_url"),
  },
  (table) => [
    index("stock_items_conversation_id_state_index").on(table.conversationId, table.state),
  ],
);

export const tocEntries = sqliteTable(
  "toc_entries",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    startSeq: integer("start_seq").notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.position] })],
);

export const questions = sqliteTable("questions", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  kind: text("kind").$type<QuestionKind>().notNull(),
  text: text("text").notNull(),
  answered: integer("answered", { mode: "boolean" }).notNull().default(false),
});

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    kind: text("kind").$type<IssueKind>(),
    state: text("state").$type<IssueState>().notNull(),
    stopReason: text("stop_reason").$type<IssueStopReason>(),
    parentId: text("parent_id"),
    priority: text("priority").$type<IssuePriority>(),
    designed: integer("designed", { mode: "boolean" }).notNull().default(false),
    confirmBeforeMerge: integer("confirm_before_merge", { mode: "boolean" })
      .notNull()
      .default(false),
    prUrl: text("pr_url"),
    githubNumber: integer("github_number"),
    createdConversationId: text("created_conversation_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    closedAt: integer("closed_at"),
  },
  (table) => [
    index("issues_project_id_state_index").on(table.projectId, table.state),
    uniqueIndex("issues_project_id_number_unique").on(table.projectId, table.number),
    uniqueIndex("issues_project_id_github_number_unique")
      .on(table.projectId, table.githubNumber)
      .where(sql`${table.githubNumber} is not null`),
  ],
);

export const issueDependencies = sqliteTable(
  "issue_dependencies",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.dependsOnId] })],
);

export const issueEvents = sqliteTable(
  "issue_events",
  {
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.seq] })],
);

export const worktrees = sqliteTable(
  "worktrees",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    path: text("path").notNull(),
    branch: text("branch").notNull(),
    branchCreated: integer("branch_created", { mode: "boolean" }).notNull().default(false),
    origin: text("origin").$type<WorktreeOrigin>().notNull(),
    issueId: text("issue_id"),
    portSlot: integer("port_slot"),
    removedAt: integer("removed_at"),
  },
  (table) => [
    uniqueIndex("worktrees_project_id_path_unique")
      .on(table.projectId, table.path)
      .where(sql`${table.removedAt} is null`),
  ],
);

export const prSnapshots = sqliteTable("pr_snapshots", {
  issueId: text("issue_id").primaryKey(),
  prUrl: text("pr_url").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
  dismissedAt: integer("dismissed_at"),
});

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull(),
  keys: text("keys", { mode: "json" }).notNull(),
  userAgent: text("user_agent").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});
