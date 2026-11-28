import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { directoriesIn } from "../../test/directories";
import { applyMigrations, migrations } from "./migrate";
import { openDatabase, type OpenedDatabase } from "./open";

export type { OpenedDatabase };

export function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), "sukuna-db-"));
}

export function removeTempHome(homeDir: string): void {
  rmSync(homeDir, { recursive: true, force: true });
}

export function openMigratedDatabase(homeDir: string): OpenedDatabase {
  const opened = openDatabase(directoriesIn(homeDir));
  const result = applyMigrations(opened.sqlite, migrations);
  if (result.isErr()) {
    opened.close();
    throw new Error(`マイグレーションを当てられませんでした: ${result.error.message}`);
  }
  return opened;
}

export function tableNames(sqlite: Database.Database): string[] {
  return sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

export function columnNames(sqlite: Database.Database, table: string): string[] {
  return sqlite
    .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
    .all(table)
    .map((row) => (row as { name: string }).name);
}

export type IndexInfo = {
  name: string;
  unique: boolean;
  partial: boolean;
  origin: string;
  columns: string[];
};

export function indexesOf(sqlite: Database.Database, table: string): IndexInfo[] {
  const rows = sqlite
    .prepare("SELECT name, [unique], origin, partial FROM pragma_index_list(?)")
    .all(table) as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  return rows.map((row) => ({
    name: row.name,
    unique: row.unique === 1,
    partial: row.partial === 1,
    origin: row.origin,
    columns: sqlite
      .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
      .all(row.name)
      .map((column) => (column as { name: string }).name),
  }));
}
