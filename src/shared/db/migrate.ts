import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { err, ok, type Result } from "neverthrow";

export type Migration = {
  tag: string;
  when: number;
  statements: string[];
  hash: string;
};

export type MigrationError = {
  type: "apply_failed";
  message: string;
};

type JournalEntry = {
  tag: string;
  when: number;
};

type Journal = {
  entries: JournalEntry[];
};

const MIGRATIONS_TABLE = "__drizzle_migrations";
const BREAKPOINT = "--> statement-breakpoint";

const sqlFiles = import.meta.glob<string>("./migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const journalFiles = import.meta.glob<string>("./migrations/meta/_journal.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

function loadMigrations(): Migration[] {
  const journalRaw = Object.values(journalFiles)[0];
  if (journalRaw === undefined) throw new Error("マイグレーションの目録がありません");
  const journal = JSON.parse(journalRaw) as Journal;
  return journal.entries.map((entry) => {
    const sql = sqlFiles[`./migrations/${entry.tag}.sql`];
    if (sql === undefined) throw new Error(`マイグレーションのファイルがありません: ${entry.tag}`);
    return {
      tag: entry.tag,
      when: entry.when,
      statements: sql
        .split(BREAKPOINT)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0),
      hash: createHash("sha256").update(sql).digest("hex"),
    };
  });
}

export const migrations: Migration[] = loadMigrations();

function readAppliedHashes(sqlite: Database.Database): Set<string> {
  const table = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (table === undefined) return new Set();
  const rows = sqlite.prepare(`SELECT hash FROM ${MIGRATIONS_TABLE}`).all() as { hash: string }[];
  return new Set(rows.map((row) => row.hash));
}

export function applyMigrations(
  sqlite: Database.Database,
  migrationsToApply: Migration[],
): Result<void, MigrationError> {
  const applied = readAppliedHashes(sqlite);
  const pending = migrationsToApply.filter((migration) => !applied.has(migration.hash));
  if (pending.length === 0) return ok(undefined);

  let current: Migration | undefined;
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    );
    const record = sqlite.prepare(
      `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`,
    );
    for (const migration of pending) {
      current = migration;
      for (const statement of migration.statements) sqlite.exec(statement);
      record.run(migration.hash, migration.when);
    }
    sqlite.exec("COMMIT");
    return ok(undefined);
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    return err({
      type: "apply_failed",
      message: `マイグレーション ${current?.tag ?? "不明"} を当てられませんでした: ${messageOf(error)}`,
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
