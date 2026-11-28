import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../../shared/db/test-helpers";
import { readEnvironment } from "../../../../shared/env";
import {
  decisionsResponseSchema,
  recapResponseSchema,
  tocResponseSchema,
} from "../../../../shared/recap/api";
import { createApp } from "../../../../server/app";
import { incomingWith } from "../../../../server/modules/identity/test-support";
import { createRecapDependencies } from "../../../../server/modules/recap/adapter/dependencies";
import { RunnerLink } from "../../../../server/runner-link";
import { startRunnerApp } from "../../../app";
import { ScriptedAgent } from "../../conversation/adapter/scripted-agent";
import type { Clock } from "../../conversation/domain/clock";
import type { RunnerNotice } from "../../../../shared/ipc";

const chapter = (title: string) => ({
  chapter: { kind: "new", title },
  decisions: [],
  changes: [],
  questions: [],
  answered: [],
});

function deferredSummary() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function fixture(responses: unknown[], clock?: Clock) {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const root = join(home, "project");
  const worktree = join(home, "worktree");
  mkdirSync(root);
  mkdirSync(worktree);
  database.sqlite
    .prepare("INSERT INTO projects (id,name,path,default_branch) VALUES ('p','test',?,'main')")
    .run(root);
  const environment = readEnvironment(
    "runner",
    { SUKUNA_HOME: home },
    home,
    () => true,
  )._unsafeUnwrap();
  const agent = new ScriptedAgent({
    rules: [
      {
        match: "最初",
        steps: [
          { text: "経過を確認した。" },
          { tool: "Read", input: { file_path: "spec.ts" }, result: "要約に渡さないツール結果" },
          { text: "休日は対象ですか？\n記録はいつ消しますか？" },
          { end: "success" },
        ],
      },
      { match: "停止する", steps: [{ text: "途中の調査" }, { hold: true }] },
      {
        match: "前に決めた",
        steps: [
          { tool: "mcp__sukuna__recap_read", input: {} },
          { text: "台本の答え" },
          { end: "success" },
        ],
      },
    ],
    fallback: [{ text: "対応しました。" }, { end: "success" }],
  });
  const summarize = vi.fn(async (_input: unknown, signal: AbortSignal) => {
    const next = responses.shift();
    return typeof next === "function" ? (next as (signal: AbortSignal) => unknown)(signal) : next;
  });
  const notices: RunnerNotice[] = [];
  const start = async () => {
    const result = await startRunnerApp({
      database,
      agent,
      environment,
      log: () => {},
      summarizer: { summarize },
      clock,
    });
    result.changes.subscribe((notice) => notices.push(notice));
    return result;
  };
  let runner = await start();
  const link = new RunnerLink({
    socket: environment.socket,
    connection: () => {},
    notice: () => {},
    log: () => {},
  });
  const api = createApp({
    build: "test",
    recap: createRecapDependencies(
      () => database.db,
      {
        forward: async (method, path) => {
          const { status, body } = (await link.call(method, path))._unsafeUnwrap();
          return Response.json(body, { status });
        },
      },
      () => {},
    ),
  });
  const request = (id: string, suffix: string, method = "GET", body?: unknown) =>
    api.request(
      `/api/conversations/${id}/${suffix}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
      incomingWith("127.0.0.1", 50000),
    );
  return {
    database,
    root,
    worktree,
    agent,
    notices,
    summarize,
    request,
    file: (id: string) => join(root, "docs/decisions", `${id}.md`),
    start: async (message?: string, cwd = root) =>
      (
        await runner.runtime.start({ projectId: "p", cwd, kind: "chat", title: "会話", message })
      )._unsafeUnwrap().conversationId,
    send: async (id: string, text: string) =>
      (await runner.runtime.send(id, { text, images: [], origin: "developer" }))._unsafeUnwrap(),
    stop: async (id: string) => (await runner.runtime.stop(id))._unsafeUnwrap(),
    toc: async (id: string) => tocResponseSchema.parse(await (await request(id, "toc")).json()),
    decisions: async (id: string) =>
      decisionsResponseSchema.parse(await (await request(id, "decisions")).json()),
    recap: async (id: string) =>
      recapResponseSchema.parse(await (await request(id, "recap")).json()),
    stopRunner: async () => runner.shutdown(),
    restart: async () => {
      await runner.shutdown();
      runner = await start();
    },
    close: async () => {
      await runner.shutdown();
      database.close();
      removeTempHome(home);
    },
  };
}

it("番の終わりに発言とツールの要約だけを別の実行に渡し、目次と未回答の質問を更新する", async () => {
  const f = await fixture([{ ...chapter("休日の扱い"), questions: [3, 4] }]);
  try {
    const id = await f.start("最初の相談");
    await vi.waitFor(async () =>
      expect((await f.toc(id)).chapters).toMatchObject([
        { position: 1, title: "休日の扱い", startSeq: 1, endSeq: null },
      ]),
    );
    const { state, questions } = await f.recap(id);
    expect(state).toEqual({ reflectedSeq: 6, failedAt: null, updating: false });
    expect(questions).toMatchObject([
      { seq: 5, text: "休日は対象ですか？", kind: "text" },
      { seq: 5, text: "記録はいつ消しますか？", kind: "text" },
    ]);
    expect(f.summarize.mock.calls[0]?.[0]).toMatchObject({
      entries: [
        { number: 1, speaker: "developer", text: "最初の相談" },
        { number: 2, speaker: "assistant", text: "経過を確認した。" },
        { text: "ツール: Read(spec.ts)" },
        { number: 3, speaker: "assistant", text: "休日は対象ですか？" },
        { number: 4, speaker: "assistant", text: "記録はいつ消しますか？" },
      ],
    });
    expect(f.agent.sent.map(({ text }) => text)).toEqual(["最初の相談"]);
    expect(f.notices).toContainEqual({
      kind: "conversation_parts",
      conversation_id: id,
      parts: ["recap"],
    });
  } finally {
    await f.close();
  }
});

it("開発者が章の開始位置を次の番の中へ動かしたときは、その位置と名前を保って反映する", async () => {
  const pending = deferredSummary();
  const f = await fixture([chapter("最初の章"), chapter("次の章"), () => pending.promise]);
  try {
    const id = await f.start("最初の章を作る");
    await vi.waitFor(async () => expect((await f.toc(id)).chapters).toHaveLength(1));
    await f.send(id, "次の章を作る");
    await vi.waitFor(async () => expect((await f.toc(id)).chapters).toHaveLength(2));
    const before = await f.toc(id);
    const second = before.chapters[1];
    await f.send(id, "ここで別の話題を始める");
    await vi.waitFor(async () => expect((await f.recap(id)).state.updating).toBe(true));
    const startSeq = before.state.reflectedSeq + 2;
    const patched = await f.request(id, "toc/2", "PATCH", {
      base: { title: second.title, startSeq: second.startSeq },
      title: "開発者の章",
      startSeq,
    });
    expect(patched.status).toBe(200);
    pending.resolve(chapter("後から返った章"));
    await vi.waitFor(async () =>
      expect((await f.toc(id)).state.reflectedSeq).toBeGreaterThan(startSeq),
    );
    expect((await f.toc(id)).chapters).toMatchObject([
      { position: 1, title: "最初の章", endSeq: startSeq - 1 },
      { position: 2, title: "開発者の章", startSeq, endSeq: null },
    ]);
  } finally {
    await f.close();
  }
});

it("更新に二度失敗した番を HTTP から作り直し、同時に届いた依頼を一つにまとめる", async () => {
  const pending = deferredSummary();
  const f = await fixture([
    chapter("予約"),
    null,
    { ...chapter("誤った質問"), questions: [1] },
    () => pending.promise,
  ]);
  try {
    const id = await f.start("予約を調べる");
    await vi.waitFor(async () => expect((await f.toc(id)).chapters).toHaveLength(1));
    const previous = await f.toc(id);
    await f.send(id, "保存方法を調べる");
    await vi.waitFor(async () => {
      const failed = await f.toc(id);
      expect(failed.chapters).toEqual(previous.chapters);
      expect(failed.state).toMatchObject({
        reflectedSeq: previous.state.reflectedSeq,
        updating: false,
      });
      expect(failed.state.failedAt).toEqual(expect.any(Number));
    });
    const requests = await Promise.all([
      f.request(id, "recap/rebuild", "POST"),
      f.request(id, "recap/rebuild", "POST"),
    ]);
    for (const request of requests) {
      expect(request.status).toBe(202);
      expect(await request.json()).toEqual({
        state: { reflectedSeq: previous.state.reflectedSeq, failedAt: null, updating: true },
      });
    }
    expect((await f.recap(id)).state).toMatchObject({ failedAt: null, updating: true });
    expect(f.summarize).toHaveBeenCalledTimes(4);
    const [first, retry, rebuild] = f.summarize.mock.calls.slice(1).map(([input]) => input);
    expect(retry).toEqual(first);
    expect(rebuild).toEqual(first);
    pending.resolve(chapter("保存方法"));
    await vi.waitFor(async () => expect((await f.toc(id)).chapters.at(-1)?.title).toBe("保存方法"));
    expect((await f.request(id, "recap/rebuild", "POST")).status).toBe(409);
    expect(f.summarize).toHaveBeenCalledTimes(4);
  } finally {
    await f.close();
  }
});

it("変わった決定の根拠とリンクを保存し、開発者が直した原文と手書き行を保つ", async () => {
  const f = await fixture([
    {
      ...chapter("保持期間"),
      decisions: [{ kind: "decision", text: "一週間保管する", reason: "暫定", line: 2 }],
      questions: [3],
    },
  ]);
  try {
    const id = await f.start("最初の相談");
    await vi.waitFor(async () =>
      expect((await f.decisions(id)).items).toMatchObject([
        { id: "D1", text: "一週間保管する", seq: 2 },
      ]),
    );
    const file = f.file(id);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("一週間保管する", "一週間保管する（手動修正）") +
        "手書きメモ\n",
    );
    const question = (await f.recap(id)).questions[0];
    f.summarize.mockImplementationOnce(async () => ({
      ...chapter("保持期間の見直し"),
      chapter: { kind: "continue" },
      decisions: [{ kind: "decision", text: "一か月保管する", line: 1 }],
      changes: [{ id: "D1", to: 1 }],
      answered: [question.id],
    }));
    await f.send(id, "一か月保管する方針に変更する");
    await vi.waitFor(async () =>
      expect((await f.decisions(id)).items).toMatchObject([
        { id: "D1", text: "一週間保管する（手動修正）", seq: 2, changedTo: "D2" },
        { id: "D2", text: "一か月保管する", seq: 7, changedTo: null },
      ]),
    );
    expect(readFileSync(file, "utf8")).toContain("→ D2");
    expect(readFileSync(file, "utf8")).toContain("手書きメモ\n");
    expect((await f.recap(id)).questions).toEqual([]);
  } finally {
    await f.close();
  }
});

it("worktree で開いた会話はプロジェクトの決定ファイルと目次を recap_read で読める", async () => {
  const f = await fixture([
    { ...chapter("運用方針"), decisions: [{ kind: "decision", text: "毎日保存する", line: 1 }] },
    { ...chapter("運用方針"), chapter: { kind: "continue" } },
    chapter("通常の会話"),
  ]);
  try {
    const id = await f.start("運用方針を決める", f.worktree);
    await vi.waitFor(async () => expect((await f.toc(id)).chapters).toHaveLength(1));
    const open = f.agent.opened[0];
    expect(open.appendSystemPrompt).toContain(f.file(id));
    expect(open.additionalDirectories).toEqual([f.root]);
    await f.send(id, "前に決めたことを教えて");
    await vi.waitFor(() => {
      const result = f.database.sqlite
        .prepare(
          "SELECT json_extract(payload, '$.content') AS content, json_extract(payload, '$.is_error') AS failed FROM conversation_events WHERE conversation_id = ? AND type = 'tool_result'",
        )
        .get(id) as { content: string; failed: number } | undefined;
      expect(result?.failed).toBe(0);
      expect(result?.content).toContain("1. 運用方針 (seq 1〜)");
      expect(result?.content).toContain(readFileSync(f.file(id), "utf8").trimEnd());
    });
    await vi.waitFor(async () => expect((await f.toc(id)).state.reflectedSeq).toBeGreaterThan(3));
    const main = await f.start("通常の会話");
    await vi.waitFor(async () => expect((await f.toc(main)).chapters).toHaveLength(1));
    expect(f.agent.opened.at(-1)?.additionalDirectories).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("停止した番も記録された終了まで反映する", async () => {
  const f = await fixture([chapter("途中の調査")]);
  try {
    const id = await f.start("停止する");
    await vi.waitFor(() => expect(f.agent.sent.map(({ text }) => text)).toEqual(["停止する"]));
    await f.stop(id);
    await vi.waitFor(async () =>
      expect((await f.toc(id)).chapters).toMatchObject([{ title: "途中の調査" }]),
    );
    const end = f.database.sqlite
      .prepare(
        "SELECT seq FROM conversation_events WHERE conversation_id = ? AND type = 'turn_end'",
      )
      .get(id) as { seq: number };
    expect((await f.recap(id)).state.reflectedSeq).toBe(end.seq);
  } finally {
    await f.close();
  }
});

it("ランナー再起動時は失敗時刻が最後の番より古い会話の残りを番ごとに積み直す", async () => {
  const f = await fixture([chapter("再開前の記録"), chapter("次の記録")]);
  try {
    const resumed = await f.start();
    const failed = await f.start();
    const sqlite = f.database.sqlite;
    const insert = sqlite.prepare(
      "INSERT INTO conversation_events (conversation_id,seq,type,payload,created_at) VALUES (?,?,?,?,?)",
    );
    const text = (id: string, seq: number, value: string) =>
      insert.run(
        id,
        seq,
        "user_message",
        JSON.stringify({ text: value, images: [], origin: "developer" }),
        seq * 100,
      );
    for (const [id, failedAt] of [
      [resumed, 350],
      [failed, 700],
    ] as const) {
      sqlite
        .prepare("UPDATE conversations SET recap_failed_at = ?, last_seq = 5 WHERE id = ?")
        .run(failedAt, id);
      text(id, 1, "再起動で途切れた指示");
      text(id, 2, "再開した指示");
      insert.run(id, 3, "turn_end", "{}", 300);
      text(id, 4, "次の指示");
      insert.run(id, 5, "turn_end", "{}", 500);
    }
    await f.restart();
    await vi.waitFor(async () =>
      expect((await f.toc(resumed)).chapters).toMatchObject([
        { title: "再開前の記録", startSeq: 1, endSeq: 3 },
        { title: "次の記録", startSeq: 4, endSeq: null },
      ]),
    );
    expect((await f.recap(resumed)).state).toEqual({
      reflectedSeq: 5,
      failedAt: null,
      updating: false,
    });
    expect((await f.recap(failed)).state).toEqual({
      reflectedSeq: 0,
      failedAt: 700,
      updating: false,
    });
    expect(f.summarize.mock.calls.map(([input]) => input)).toMatchObject([
      { entries: [{ text: "再起動で途切れた指示" }, { text: "再開した指示" }] },
      { entries: [{ text: "次の指示" }] },
    ]);
  } finally {
    await f.close();
  }
});

it("制限時間を過ぎた応答を破棄し、次の番の完了で未反映の番からやり直す", async () => {
  const time = new Map<number, () => void>();
  let now = 100;
  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      if (ms === 30_000) {
        const key = time.size + 1;
        time.set(key, callback);
        return () => {
          time.delete(key);
        };
      }
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  };
  const pending = deferredSummary();
  const f = await fixture(
    [() => pending.promise, chapter("やり直した章"), chapter("次の話題")],
    clock,
  );
  try {
    const id = await f.start("要約が遅い指示");
    await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledTimes(1));
    now += 30_000;
    for (const expire of time.values()) expire();
    await vi.waitFor(async () =>
      expect((await f.toc(id)).state).toEqual({
        reflectedSeq: 0,
        failedAt: now,
        updating: false,
      }),
    );
    expect(f.summarize.mock.calls[0]?.[1].aborted).toBe(true);
    pending.resolve(chapter("遅れた結果"));
    now += 100;
    await f.send(id, "次の話題");
    await vi.waitFor(async () =>
      expect((await f.toc(id)).chapters).toMatchObject([
        { title: "やり直した章", startSeq: 1 },
        { title: "次の話題", startSeq: 4 },
      ]),
    );
    expect(f.summarize.mock.calls[1]?.[0]).toEqual(f.summarize.mock.calls[0]?.[0]);
  } finally {
    await f.close();
  }
});

async function lockDatabase(file: string) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked");
    process.stdin.once("end", () => { db.exec("ROLLBACK"); db.close(); });
    process.stdin.resume();
  `,
      file,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exit = once(child, "exit");
  try {
    const ready = Promise.race([
      once(child.stdout, "data"),
      exit.then(() => {
        throw new Error("テスト用 SQLite のロックを開始できませんでした。");
      }),
    ]);
    expect(String((await ready)[0])).toBe("locked");
  } catch (error) {
    child.stdin.end();
    await exit;
    throw error;
  }
  return async () => {
    child.stdin.end();
    expect(await exit).toEqual([0, null]);
  };
}

it("決定のファイル保存後に SQLite の反映が失敗しても、再起動後の作り直しで発言と番号を一度だけ反映する", async () => {
  const pending = deferredSummary();
  const f = await fixture([
    {
      ...chapter("保存方法"),
      decisions: [{ kind: "decision", text: "前の決定", line: 1 }],
    },
    () => pending.promise,
    chapter("前の要約は再実行しない"),
  ]);
  try {
    const id = await f.start("保存方法を決める");
    await vi.waitFor(async () => expect((await f.decisions(id)).items[0]?.id).toBe("D1"));
    f.database.sqlite.exec(
      "CREATE TRIGGER deny_recap_advance BEFORE UPDATE OF recap_seq ON conversations WHEN NEW.recap_seq > 3 BEGIN SELECT RAISE(ABORT, '反映位置を保存できない'); END",
    );
    await f.send(id, "二つの保存先に同じ方針を取る");
    await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledTimes(2));
    pending.resolve({
      ...chapter("新しい保存先"),
      decisions: [
        { kind: "decision", text: "一週間保存する", line: 1 },
        { kind: "decision", text: "一週間保存する", line: 1 },
      ],
      changes: [{ id: "D1", to: 2 }],
      questions: [2],
    });
    await vi.waitFor(async () =>
      expect((await f.toc(id)).state.failedAt).toEqual(expect.any(Number)),
    );
    const partial = await f.decisions(id);
    expect(partial.state).toMatchObject({ reflectedSeq: 3, updating: false });
    expect(partial.items).toMatchObject([
      { id: "D1", changedTo: "D3" },
      { id: "D2", text: "一週間保存する", seq: 4 },
      { id: "D3", text: "一週間保存する", seq: 4 },
    ]);
    const edited = partial.items.map((item) =>
      item.id === "D2" ? { ...item, text: "編集した保存方法" } : item,
    );
    expect(
      (
        await f.request(id, "decisions", "PUT", {
          baseHash: partial.hash,
          items: edited,
        })
      ).status,
    ).toBe(200);
    const path = f.file(id);
    writeFileSync(path, readFileSync(path, "utf8") + "手書きのメモ\n");
    const original = readFileSync(path, "utf8");

    f.database.sqlite.exec("DROP TRIGGER deny_recap_advance");
    await f.restart();
    const rebuild = await f.request(id, "recap/rebuild", "POST");
    expect(rebuild.status).toBe(202);
    await vi.waitFor(async () => {
      expect((await f.recap(id)).state).toEqual({
        reflectedSeq: 6,
        updating: false,
        failedAt: null,
      });
    });
    expect((await f.decisions(id)).items).toEqual(edited);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect((await f.recap(id)).questions).toMatchObject([{ seq: 5, text: "対応しました。" }]);
    expect(f.summarize).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

function holdWriteRetry() {
  let resume: (() => void | Promise<void>) | undefined;
  const clock: Clock = {
    now: Date.now,
    setTimeout: (callback, ms) => {
      if (ms === 50) {
        resume = callback;
        return () => {
          resume = undefined;
        };
      }
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  };
  return { clock, waiting: () => resume !== undefined, resume: () => resume?.() };
}

it("別プロセスが二度の SQLite 書き込みを塞いでも、ロック解放後に失敗を表示する", async () => {
  const pending = deferredSummary();
  const retry = holdWriteRetry();
  const f = await fixture([() => pending.promise], retry.clock);
  let release: (() => Promise<void>) | undefined;
  try {
    f.database.sqlite.pragma("busy_timeout = 30");
    const id = await f.start("最初の番をまとめる");
    await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledTimes(1));
    release = await lockDatabase(f.database.sqlite.name);
    pending.resolve(chapter("これまでの経過"));
    await vi.waitFor(() => expect(retry.waiting()).toBe(true));
    expect((await f.toc(id)).state).toEqual({ reflectedSeq: 0, failedAt: null, updating: true });
    await release();
    release = undefined;
    await retry.resume();
    await vi.waitFor(async () => {
      expect((await f.toc(id)).state).toEqual({
        reflectedSeq: 0,
        failedAt: expect.any(Number),
        updating: false,
      });
    });
    expect(f.notices).toContainEqual({
      kind: "conversation_parts",
      conversation_id: id,
      parts: ["recap"],
    });
    expect((await f.toc(id)).chapters).toEqual([]);
  } finally {
    await release?.();
    await f.close();
  }
});

it("失敗時刻の保存を待つ間に次の番が終わると、前の番から反映して古い失敗を表示しない", async () => {
  const pending = deferredSummary();
  const retry = holdWriteRetry();
  const f = await fixture(
    [() => pending.promise, chapter("前の番"), chapter("新しい番")],
    retry.clock,
  );
  let release: (() => Promise<void>) | undefined;
  try {
    f.database.sqlite.pragma("busy_timeout = 30");
    const id = await f.start("前の番");
    await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledTimes(1));
    release = await lockDatabase(f.database.sqlite.name);
    pending.resolve(chapter("保存が失敗した番"));
    await vi.waitFor(() => expect(retry.waiting()).toBe(true));
    await release();
    release = undefined;
    await f.send(id, "新しい番");
    await vi.waitFor(async () => {
      const toc = await f.toc(id);
      expect(toc.chapters.map(({ title }) => title)).toEqual(["前の番", "新しい番"]);
      expect(toc.state).toEqual({ reflectedSeq: 6, failedAt: null, updating: false });
    });
    expect(f.summarize).toHaveBeenCalledTimes(3);
    expect(retry.waiting()).toBe(false);
  } finally {
    await release?.();
    await f.close();
  }
});

it("失敗時刻の消去がロックされても作り直しを受け付け、ランナー終了後に古い仕事を再開しない", async () => {
  const retry = holdWriteRetry();
  const f = await fixture([null, null, chapter("再起動後に作り直した章")], retry.clock);
  let release: (() => Promise<void>) | undefined;
  try {
    f.database.sqlite.pragma("busy_timeout = 30");
    const id = await f.start("失敗した番");
    await vi.waitFor(async () =>
      expect((await f.toc(id)).state.failedAt).toEqual(expect.any(Number)),
    );
    release = await lockDatabase(f.database.sqlite.name);
    const attempts = await Promise.all([
      f.request(id, "recap/rebuild", "POST"),
      f.request(id, "recap/rebuild", "POST"),
    ]);
    expect(attempts.map((response) => response.status)).toEqual([202, 202]);
    await vi.waitFor(() => expect(retry.waiting()).toBe(true));
    expect(f.summarize).toHaveBeenCalledTimes(2);
    await f.stopRunner();
    expect(retry.waiting()).toBe(false);
    await release();
    release = undefined;
    await f.restart();
    expect((await f.toc(id)).state).toMatchObject({
      reflectedSeq: 0,
      failedAt: expect.any(Number),
      updating: false,
    });
    expect((await f.request(id, "recap/rebuild", "POST")).status).toBe(202);
    await vi.waitFor(async () =>
      expect((await f.toc(id)).state).toEqual({
        reflectedSeq: 3,
        failedAt: null,
        updating: false,
      }),
    );
    expect(f.summarize).toHaveBeenCalledTimes(3);
  } finally {
    await release?.();
    await f.close();
  }
});

it("失敗時刻を保存できない間の作り直しを引き受け、同じ番の要約に合流する", async () => {
  const pending = deferredSummary();
  const rebuilding = deferredSummary();
  const retry = holdWriteRetry();
  const f = await fixture([() => pending.promise, () => rebuilding.promise], retry.clock);
  let release: (() => Promise<void>) | undefined;
  try {
    f.database.sqlite.pragma("busy_timeout = 30");
    const id = await f.start("章を作る");
    await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledTimes(1));
    release = await lockDatabase(f.database.sqlite.name);
    pending.resolve(chapter("最初の試行"));
    await vi.waitFor(() => expect(retry.waiting()).toBe(true));
    await release();
    release = undefined;
    const responses = await Promise.all([
      f.request(id, "recap/rebuild", "POST"),
      f.request(id, "recap/rebuild", "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledTimes(2));
    const [first, second] = f.summarize.mock.calls;
    expect(second?.[0]).toEqual(first?.[0]);
    expect((await f.toc(id)).state).toEqual({ reflectedSeq: 0, failedAt: null, updating: true });
    rebuilding.resolve(chapter("作り直した章"));
    await vi.waitFor(async () => {
      const toc = await f.toc(id);
      expect(toc.state).toEqual({ reflectedSeq: 3, failedAt: null, updating: false });
      expect(toc.chapters).toMatchObject([{ title: "作り直した章" }]);
    });
    expect(f.summarize).toHaveBeenCalledTimes(2);
    expect(retry.waiting()).toBe(false);
  } finally {
    await release?.();
    await f.close();
  }
});

it.each([
  {
    format: "旧形式の LF",
    newline: "\n",
    head: ["# 予約の決定"],
    existing: "- [決定] D1: 開発者の方針",
  },
  {
    format: "v2 の CRLF",
    newline: "\r\n",
    head: [
      "<!-- sukuna-decisions:v2 -->",
      "<!-- sukuna-recap:applied=7:550e8400-e29b-41d4-a716-446655440000 -->",
      "# 予約の決定",
    ],
    existing: '- [決定] D1: "開発者の方針"',
  },
])(
  "$format の手書きコメントとコード例を残し、管理用ヘッダーだけを更新する",
  async ({ newline, head, existing }) => {
    const f = await fixture([
      { ...chapter("最初の予約"), decisions: [{ kind: "decision", text: "最初の決定", line: 1 }] },
      { ...chapter("次の予約"), decisions: [{ kind: "decision", text: "次の決定", line: 1 }] },
    ]);
    try {
      const id = await f.start();
      const file = f.file(id);
      mkdirSync(join(f.root, "docs/decisions"), { recursive: true });
      const manualHead = head[0] === "<!-- sukuna-decisions:v2 -->" ? head.slice(1) : head;
      const example = [
        "<!-- 手書きの例 -->",
        "```markdown",
        "<!-- sukuna-recap:applied=3:------------------------------------ -->",
        "<!-- sukuna-recap:applied=4:550e8400-e29b-41d4-a716-446655440000 -->",
        "<!-- sukuna-decisions:v3 recap=4:550e8400-e29b-41d4-a716-446655440000 -->",
        "```",
        "",
      ].join(newline);
      writeFileSync(file, head.join(newline) + newline + existing + newline + example);
      await f.send(id, "初回の方針");
      await vi.waitFor(async () => expect((await f.decisions(id)).items.at(-1)?.id).toBe("D2"));
      const first = readFileSync(file, "utf8");
      expect(first).toContain(example);
      expect(first).toContain(manualHead.join(newline) + newline);
      const initialMark = first.split(newline)[0];
      await f.send(id, "次の方針");
      await vi.waitFor(async () => expect((await f.decisions(id)).items.at(-1)?.id).toBe("D3"));
      const updated = readFileSync(file, "utf8");
      expect(updated).toContain(example);
      expect(updated).toContain(manualHead.join(newline) + newline);
      expect(updated.split(newline)[0]).toMatch(
        /^<!-- sukuna-decisions:v3 recap=6:[0-9a-f-]+ -->$/,
      );
      expect(updated).not.toContain(initialMark);
      expect((await f.decisions(id)).items.map(({ id, text }) => ({ id, text }))).toEqual([
        { id: "D1", text: "開発者の方針" },
        { id: "D2", text: "最初の決定" },
        { id: "D3", text: "次の決定" },
      ]);
    } finally {
      await f.close();
    }
  },
);
