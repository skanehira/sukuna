import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { openDatabase, type OpenedDatabase } from "../../../../shared/db/open";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { STOCK_SEND_SETTLEMENT_TIMEOUT_MS } from "../../../../shared/ipc";
import { stockSendReceipt } from "../../../../shared/stock-send-receipts";
import { createStockSendSettlement } from "./settle-send";
import { directoriesIn } from "../../../../test/directories";

let home: string;
let runner: OpenedDatabase;
let server: OpenedDatabase;
const attempt = "85929ad9-a2ad-4ea5-b76d-00b0301b9b56";
const instruction = { count: 1, delivery: "delivered" } as const;
const unresolved = {
  code: "internal",
  message: "ストックの送信結果を確かめられませんでした。一覧を読み直してください。",
};

beforeEach(() => {
  home = createTempHome();
  runner = openMigratedDatabase(home);
  server = openDatabase(directoriesIn(home));
  runner.sqlite
    .prepare("INSERT INTO projects (id,name,path,default_branch) VALUES ('p','fixture',?,'main')")
    .run(home);
  runner.sqlite
    .prepare(
      "INSERT INTO conversations (id,project_id,kind,cwd,closed_at) VALUES ('c','p','chat',?,1)",
    )
    .run(home);
  runner.db.transaction(
    (tx) => {
      const receipt = stockSendReceipt(tx, attempt, "c");
      receipt.start([]);
      receipt.instructions(instruction, 1);
    },
    { behavior: "immediate" },
  );
});
afterEach(() => {
  server.close();
  runner.close();
  removeTempHome(home);
});

it("書き込みロックが回復の期限まで続く場合は内部エラーを返し、受付結果を維持する", async () => {
  let now = 0;
  const waits: number[] = [];
  const reconcile = createStockSendSettlement(() => server, {
    now: () => now,
    wait: async (delay) => {
      waits.push(delay);
      now = STOCK_SEND_SETTLEMENT_TIMEOUT_MS;
    },
  });
  runner.sqlite.exec("BEGIN IMMEDIATE");
  try {
    expect((await reconcile("c", attempt, true))._unsafeUnwrapErr()).toEqual(unresolved);
    expect(waits).toEqual([50]);
    expect(server.sqlite.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(server.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='c'").get()).toEqual(
      { closed_at: 1 },
    );
  } finally {
    runner.sqlite.exec("COMMIT");
  }
  expect((await reconcile("c", attempt, true))._unsafeUnwrap()).toEqual({
    reopened: true,
    recovered: { instructions: instruction, questions: [] },
  });
});

it("書き込みの制約違反は待たずに内部エラーを返し、その後の照合で正常に開く", async () => {
  const waits: number[] = [];
  const reconcile = createStockSendSettlement(() => server, {
    now: () => 0,
    wait: async (delay) => {
      waits.push(delay);
      throw new Error("制約違反を再試行しています");
    },
  });
  runner.sqlite.exec(
    "CREATE TRIGGER unsettled BEFORE UPDATE OF closed_at ON conversations BEGIN SELECT RAISE(FAIL, 'fixture'); END",
  );
  expect((await reconcile("c", attempt, true))._unsafeUnwrapErr()).toEqual(unresolved);
  expect(waits).toEqual([]);
  expect(server.sqlite.pragma("busy_timeout", { simple: true })).toBe(5_000);
  expect(server.sqlite.prepare("SELECT closed_at FROM conversations WHERE id='c'").get()).toEqual({
    closed_at: 1,
  });
  runner.sqlite.exec("DROP TRIGGER unsettled");
  expect((await reconcile("c", attempt, true))._unsafeUnwrap()).toEqual({
    reopened: true,
    recovered: { instructions: instruction, questions: [] },
  });
});
