import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { newIssue } from "../../../../shared/issue/rules";
import { conversations } from "../../../../shared/db/schema";
import { createIssueDataUnitOfWork } from "./issue-repository";

describe("issue の採番とトランザクション", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const close of cleanups.splice(0)) close();
  });
  function fixture() {
    const home = createTempHome();
    const database = openMigratedDatabase(home);
    cleanups.push(() => {
      database.close();
      removeTempHome(home);
    });
    const unit = createIssueDataUnitOfWork(database.db);
    unit.run((repo) => repo.insert(newIssue("existing", "p", 1, 1000, false), []));
    return { unit, database };
  }
  it.each(
    (["chat", "thread", "triage", "design", "impl"] as const).flatMap((kind) =>
      (
        [
          "idle",
          "working",
          "waiting_answer",
          "waiting_permission",
          "stopped",
          "failed",
          "usage_limited",
        ] as const
      ).map((runState) => ({ kind, runState })),
    ),
  )("取り下げの停止対象 $kind/$runState を段階と作業中の状態で選ぶ", ({ kind, runState }) => {
    const { unit, database } = fixture();
    database.db
      .insert(conversations)
      .values([
        { id: "candidate", projectId: "p", issueId: "existing", kind, runState, cwd: "/tmp" },
        {
          id: "other-issue",
          projectId: "p",
          issueId: "other",
          kind: "triage",
          runState: "working",
          cwd: "/tmp",
        },
      ])
      .run();
    const selected =
      ["triage", "design", "impl"].includes(kind) &&
      ["working", "waiting_answer", "waiting_permission"].includes(runState);
    expect(unit.read.activeConversationIds("existing")).toEqual(selected ? ["candidate"] : []);
  });
  it("番号の一意の制約に当たると変更をロールバックし、番号を1回だけ取り直す", () => {
    const { unit, database } = fixture();
    let attempts = 0;
    const number = unit.create((repo) => {
      attempts++;
      repo.append(
        "existing",
        "comment",
        { text: `attempt-${attempts}`, conversationId: "c" },
        1000,
      );
      const next = attempts === 1 ? 1 : repo.nextNumber("p");
      repo.insert(newIssue("new", "p", next, 1000, false), []);
      return next;
    });
    expect({ number, attempts }).toEqual({ number: 2, attempts: 2 });
    expect(database.sqlite.prepare("SELECT number FROM issues ORDER BY number").all()).toEqual([
      { number: 1 },
      { number: 2 },
    ]);
    expect(database.sqlite.prepare("SELECT seq,payload FROM issue_events").all()).toEqual([
      { seq: 1, payload: '{"text":"attempt-2","conversationId":"c"}' },
    ]);
  });
  it("2回とも一意の制約に当たればそれ以上試さず、元のissueだけを残す", () => {
    const { unit, database } = fixture();
    let attempts = 0;
    expect(() =>
      unit.create((repo) => {
        attempts++;
        repo.insert(newIssue("new", "p", 1, 1000, false), []);
      }),
    ).toThrow("UNIQUE constraint failed: issues.project_id, issues.number");
    expect({
      attempts,
      rows: database.sqlite.prepare("SELECT id,number FROM issues").all(),
    }).toEqual({ attempts: 2, rows: [{ id: "existing", number: 1 }] });
  });
  it("番号以外の一意の制約違反は取り直さず、保存しない", () => {
    const { unit, database } = fixture();
    let attempts = 0;
    expect(() =>
      unit.create((repo) => {
        attempts++;
        repo.insert(newIssue("existing", "p", 2, 1000, false), []);
      }),
    ).toThrow("UNIQUE constraint failed: issues.id");
    expect({
      attempts,
      rows: database.sqlite.prepare("SELECT id,number FROM issues").all(),
    }).toEqual({ attempts: 1, rows: [{ id: "existing", number: 1 }] });
  });
});
