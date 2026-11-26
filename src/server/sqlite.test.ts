import Database from "better-sqlite3";
import { describe, expect, it } from "vite-plus/test";

describe("better-sqlite3", () => {
  it("本物の SQLite を開いて問い合わせられる", () => {
    const database = new Database(":memory:");

    try {
      expect(database.prepare("SELECT 1 AS value").get()).toEqual({ value: 1 });
    } finally {
      database.close();
    }
  });
});
