import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Directories } from "../env";
import * as schema from "./schema";

export type OpenedDatabase = {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  directories: Directories;
  close: () => void;
};

export function openDatabase(directories: Directories): OpenedDatabase {
  mkdirSync(directories.data, { recursive: true });
  const sqlite = new Database(join(directories.data, "sukuna.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    directories,
    close: () => sqlite.close(),
  };
}
