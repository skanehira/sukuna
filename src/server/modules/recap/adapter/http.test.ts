import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../../shared/db/test-helpers";
import { openDatabase } from "../../../../shared/db/open";
import { createApp } from "../../../app";
import { incomingWith } from "../../identity/test-support";
import { createTailscaleLocalApi } from "../../identity/adapter/tailscale-local-api";
import { createRecapDependencies } from "./dependencies";
import {
  recapResponseSchema,
  tocResponseSchema,
  decisionsResponseSchema,
} from "../../../../shared/recap/api";
import type { DecisionItem } from "../../../../shared/recap/decision-file";
import type { RecapDependencies } from "../domain/ports";

const state = { reflectedSeq: 0, failedAt: null, updating: false };
const item: DecisionItem = {
  id: "D1",
  kind: "decision",
  text: "24 時間前",
  reason: null,
  seq: 4,
  changedTo: null,
};
const line = "- [決定] D1: 24 時間前 <!-- seq=4 -->\n";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");

describe("会話の直近・目次・決まったこと API", () => {
  let home: string;
  let database: OpenedDatabase;
  let root: string;
  let file: string;
  let deps: RecapDependencies;
  let notices: string[];
  beforeEach(() => {
    home = createTempHome();
    database = openMigratedDatabase(home);
    root = join(home, "project");
    mkdirSync(join(root, "docs/decisions"), { recursive: true });
    file = join(root, "docs/decisions/c.md");
    database.sqlite
      .prepare("INSERT INTO projects (id,name,path,default_branch) VALUES ('p','test',?,'main')")
      .run(root);
    database.sqlite
      .prepare(
        "INSERT INTO conversations (id,project_id,kind,cwd,title,last_seq) VALUES ('c','p','chat',?,'予約 API',20)",
      )
      .run(join(home, "worktree"));
    notices = [];
    deps = createRecapDependencies(
      () => database.db,
      {
        forward: async () =>
          Response.json(
            {
              error: {
                code: "runner_unavailable",
                message:
                  "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
              },
            },
            { status: 503 },
          ),
      },
      (id) => notices.push(id),
    );
  });
  afterEach(() => {
    database.close();
    removeTempHome(home);
  });
  function request(path: string, method = "GET", body?: unknown) {
    return createApp({
      build: "test",
      identity: {
        login: "dev@example.com",
        devIdentity: "dev@example.com",
        clock: { now: () => 0 },
        tailscale: createTailscaleLocalApi(),
      },
      recap: deps,
    }).request(
      `/api/conversations/${path}`,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      },
      incomingWith("127.0.0.1", 50000),
    );
  }
  function event(seq: number, type: string, payload: unknown, createdAt = seq * 100) {
    database.sqlite
      .prepare(
        "INSERT INTO conversation_events (conversation_id,seq,type,payload,created_at) VALUES ('c',?,?,?,?)",
      )
      .run(seq, type, JSON.stringify(payload), createdAt);
  }
  it("US-073: 最後の発言・順序通りの未回答質問・画像の書きかけ・未送信の件数と終了済みスレッドを返す", async () => {
    event(1, "user_message", { text: "最初", origin: "developer", images: [] });
    event(4, "user_message", { text: "最後の自分の発言", origin: "developer", images: [] });
    event(5, "user_message", { text: "自動の指示", origin: "flow", images: [] });
    event(6, "turn_end", {});
    database.sqlite
      .prepare(
        "INSERT INTO questions (id,conversation_id,seq,kind,text,answered) VALUES (?,?,?,?,?,?)",
      )
      .run("z", "c", 5, "choice", "どちらにしますか?", 0);
    database.sqlite
      .prepare(
        "INSERT INTO questions (id,conversation_id,seq,kind,text,answered) VALUES (?,?,?,?,?,?)",
      )
      .run("a", "c", 5, "choice", "次の質問?", 0);
    database.sqlite
      .prepare(
        "INSERT INTO questions (id,conversation_id,seq,kind,text,answered) VALUES (?,?,?,?,?,?)",
      )
      .run("b", "c", 2, "text", "そのままの質問?", 0);
    database.sqlite
      .prepare(
        "INSERT INTO questions (id,conversation_id,seq,kind,text,answered) VALUES (?,?,?,?,?,?)",
      )
      .run("x", "c", 1, "text", "回答済み", 1);
    database.sqlite
      .prepare(
        "INSERT INTO drafts (conversation_id,text,images,updated_at,updated_by) VALUES ('c','',?,1,'tab')",
      )
      .run('["image.png"]');
    for (const [id, stockState] of [
      ["s1", "stocked"],
      ["s2", "stocked"],
      ["s3", "sent"],
      ["s4", "cancelled"],
    ])
      database.sqlite
        .prepare(
          "INSERT INTO stock_items (id,conversation_id,kind,text,state) VALUES (?,'c','instruction','text',?)",
        )
        .run(id, stockState);
    for (const [id, runState, closedAt] of [
      ["t1", "working", null],
      ["t2", "idle", 1],
      ["t3", "waiting_answer", null],
    ])
      database.sqlite
        .prepare(
          "INSERT INTO conversations (id,project_id,kind,cwd,parent_conversation_id,run_state,closed_at) VALUES (?,'p','thread',?,'c',?,?)",
        )
        .run(id, root, runState, closedAt);
    database.sqlite
      .prepare(
        "INSERT INTO queued_instructions (id,conversation_id,text,position,created_at) VALUES ('q','c','text',1,1)",
      )
      .run();
    const response = await request("c/recap");
    expect(response.status).toBe(200);
    expect(recapResponseSchema.parse(await response.json())).toEqual({
      lastUserMessage: { seq: 4, text: "最後の自分の発言" },
      questions: [
        { id: "b", seq: 2, kind: "text", text: "そのままの質問?" },
        { id: "z", seq: 5, kind: "choice", text: "どちらにしますか?" },
        { id: "a", seq: 5, kind: "choice", text: "次の質問?" },
      ],
      pendingPermission: null,
      draft: { exists: true },
      counts: { stock: 2, threads: 3, activeThreads: 1, queue: 1 },
      lastReadSeq: 0,
      lastPosition: null,
      state: { ...state, updating: true },
    });
  });
  it("空の会話と空の書きかけには空の直近を返す", async () => {
    database.sqlite
      .prepare(
        "INSERT INTO drafts (conversation_id,text,images,updated_at,updated_by) VALUES ('c','', '[]',1,'tab')",
      )
      .run();
    expect(recapResponseSchema.parse(await (await request("c/recap")).json())).toEqual({
      lastUserMessage: null,
      questions: [],
      pendingPermission: null,
      draft: { exists: false },
      counts: { stock: 0, threads: 0, activeThreads: 0, queue: 0 },
      lastReadSeq: 0,
      lastPosition: null,
      state,
    });
  });
  it.each([
    [null, 0, true],
    [599, 0, true],
    [600, 0, false],
    [601, 0, false],
    [null, 6, false],
  ])("最後の番に対して失敗 %s・反映 %i なら更新中 %s", async (failedAt, reflectedSeq, updating) => {
    event(6, "turn_end", {}, 600);
    database.sqlite
      .prepare("UPDATE conversations SET recap_seq=?,recap_failed_at=? WHERE id='c'")
      .run(reflectedSeq, failedAt);
    const response = await request("c/toc");
    expect(await response.json()).toEqual({
      chapters: [],
      state: { reflectedSeq, failedAt, updating },
    });
  });
  it("待機中の許可の確認だけを返し、許可済みや停止後には残さない", async () => {
    event(2, "permission_request", {
      request_id: "old",
      tool_name: "Read",
      input: {},
      title: "古い確認",
    });
    event(3, "permission_decision", { request_id: "old", behavior: "allow" });
    event(4, "permission_request", {
      request_id: "r",
      tool_name: "Write",
      input: {},
      title: "docs/a.md",
    });
    database.sqlite
      .prepare("UPDATE conversations SET run_state='waiting_permission' WHERE id='c'")
      .run();
    const expected = {
      lastUserMessage: null,
      questions: [],
      pendingPermission: { requestId: "r", seq: 4, toolName: "Write", summary: "docs/a.md" },
      draft: { exists: false },
      counts: { stock: 0, threads: 0, activeThreads: 0, queue: 0 },
      lastReadSeq: 0,
      lastPosition: null,
      state,
    };
    expect(await (await request("c/recap")).json()).toEqual(expected);
    event(5, "permission_decision", { request_id: "r", behavior: "deny" });
    expect(await (await request("c/recap")).json()).toEqual({
      ...expected,
      pendingPermission: null,
    });
    event(6, "permission_request", { request_id: "stopped", tool_name: "Read", input: {} });
    database.sqlite.prepare("UPDATE conversations SET run_state='stopped' WHERE id='c'").run();
    expect(await (await request("c/recap")).json()).toEqual({
      ...expected,
      pendingPermission: null,
    });
  });
  it("無関係な許可への回答では現在の確認を消さない", async () => {
    event(4, "permission_request", {
      request_id: "r",
      tool_name: "Write",
      input: {},
      title: "docs/a.md",
    });
    event(5, "permission_decision", { request_id: "unrelated", behavior: "allow" });
    database.sqlite
      .prepare("UPDATE conversations SET run_state='waiting_permission' WHERE id='c'")
      .run();
    const expected = {
      lastUserMessage: null,
      questions: [],
      pendingPermission: { requestId: "r", seq: 4, toolName: "Write", summary: "docs/a.md" },
      draft: { exists: false },
      counts: { stock: 0, threads: 0, activeThreads: 0, queue: 0 },
      lastReadSeq: 0,
      lastPosition: null,
      state,
    };
    expect(await (await request("c/recap")).json()).toEqual(expected);
  });
  it("SQLite が書き込み中でも内部のエラーコードを公開せず再操作を案内する", async () => {
    database.sqlite.prepare("INSERT INTO toc_entries VALUES ('c',1,'最初',1)").run();
    const other = openDatabase(home);
    database.sqlite.pragma("busy_timeout = 0");
    other.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const response = await request("c/toc/1", "PATCH", {
        title: "変更",
        base: { title: "最初", startSeq: 1 },
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: {
          code: "internal",
          message: "会話の状況を読み書きできませんでした。もう一度操作してください。",
        },
      });
    } finally {
      other.sqlite.exec("ROLLBACK");
      other.close();
    }
    expect(database.sqlite.prepare("SELECT title,start_seq FROM toc_entries").all()).toEqual([
      { title: "最初", start_seq: 1 },
    ]);
  });
  it("既読は増やす方向に last_seq まで進め、位置は後着の端末の値にする", async () => {
    for (const [body, expected] of [
      [
        { readSeq: 12, position: 10 },
        { last_read_seq: 12, last_position: 10 },
      ],
      [
        { readSeq: 3, position: 2 },
        { last_read_seq: 12, last_position: 2 },
      ],
      [{ readSeq: 50 }, { last_read_seq: 20, last_position: 2 }],
      [{}, { last_read_seq: 20, last_position: 2 }],
    ]) {
      expect((await request("c/read", "POST", body)).status).toBe(204);
      expect(
        database.sqlite
          .prepare("SELECT last_read_seq,last_position FROM conversations WHERE id='c'")
          .get(),
      ).toEqual(expected);
    }
    expect(notices).toEqual(["c", "c", "c", "c"]);
  });
  it("目次は章の範囲の現在の決定だけ返す", async () => {
    database.sqlite
      .prepare("INSERT INTO toc_entries VALUES ('c',1,'最初',1),('c',2,'次',10)")
      .run();
    writeFileSync(
      file,
      `${line}- [決定] D2: 古い → D3 <!-- seq=5 -->\n- [保留] D3: 保留 <!-- seq=6 -->\n- [決定] D4: 新しい <!-- seq=10 -->\n- [決定] D5: 手書き\n- [決定] D6: 章末の決定 <!-- seq=9 -->\n`,
    );
    const response = await request("c/toc");
    expect(tocResponseSchema.parse(await response.json())).toEqual({
      chapters: [
        {
          position: 1,
          title: "最初",
          startSeq: 1,
          endSeq: 9,
          decisions: [
            { id: "D1", text: "24 時間前" },
            { id: "D6", text: "章末の決定" },
          ],
        },
        {
          position: 2,
          title: "次",
          startSeq: 10,
          endSeq: null,
          decisions: [{ id: "D4", text: "新しい" }],
        },
      ],
      state,
    });
  });
  it("章の題名と始まりを base が合うときだけ更新し、古い base は上書きしない", async () => {
    database.sqlite
      .prepare("INSERT INTO toc_entries VALUES ('c',1,'最初',1),('c',2,'次',10),('c',3,'最後',20)")
      .run();
    const patch = { title: "在庫", startSeq: 12, base: { title: "次", startSeq: 10 } };
    const response = await request("c/toc/2", "PATCH", patch);
    expect(response.status).toBe(200);
    expect(tocResponseSchema.parse(await response.json())).toEqual({
      chapters: [
        { position: 1, title: "最初", startSeq: 1, endSeq: 11, decisions: [] },
        { position: 2, title: "在庫", startSeq: 12, endSeq: 19, decisions: [] },
        { position: 3, title: "最後", startSeq: 20, endSeq: null, decisions: [] },
      ],
      state,
    });
    expect((await request("c/toc/2", "PATCH", patch)).status).toBe(409);
    expect(
      database.sqlite
        .prepare("SELECT position,title,start_seq FROM toc_entries ORDER BY position")
        .all(),
    ).toEqual([
      { position: 1, title: "最初", start_seq: 1 },
      { position: 2, title: "在庫", start_seq: 12 },
      { position: 3, title: "最後", start_seq: 20 },
    ]);
    expect(notices).toEqual(["c"]);
  });
  it.each([{ title: "" }, { title: "名".repeat(61) }, { startSeq: 1 }, { startSeq: 20 }])(
    "範囲や長さの合わない章の変更は拒否する: %j",
    async (patch) => {
      database.sqlite
        .prepare(
          "INSERT INTO toc_entries VALUES ('c',1,'最初',1),('c',2,'次',10),('c',3,'最後',20)",
        )
        .run();
      expect(
        (await request("c/toc/2", "PATCH", { ...patch, base: { title: "次", startSeq: 10 } }))
          .status,
      ).toBe(400);
      expect(
        database.sqlite.prepare("SELECT title,start_seq FROM toc_entries WHERE position=2").get(),
      ).toEqual({ title: "次", start_seq: 10 });
    },
  );
  it("1 章の題名だけを 60 文字まで直せるが始まりは動かせない", async () => {
    database.sqlite.prepare("INSERT INTO toc_entries VALUES ('c',1,'最初',1)").run();
    expect(
      (
        await request("c/toc/1", "PATCH", {
          title: "名".repeat(60),
          base: { title: "最初", startSeq: 1 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("c/toc/1", "PATCH", {
          startSeq: 2,
          base: { title: "名".repeat(60), startSeq: 1 },
        })
      ).status,
    ).toBe(400);
  });
  it("US-075: 項目を直すとプロジェクトのファイルが更新され、手書き行が残り、古い hash は競合する", async () => {
    const source = `# 手書きの題名\n${line}手書きの文\n`;
    writeFileSync(file, source);
    expect(decisionsResponseSchema.parse(await (await request("c/decisions")).json())).toEqual({
      path: "docs/decisions/c.md",
      exists: true,
      hash: hash(source),
      items: [item],
      state,
    });
    const edited = { ...item, kind: "pending", text: "12 時間前", reason: "再検討" };
    const response = await request("c/decisions", "PUT", {
      baseHash: hash(source),
      items: [edited],
    });
    const updated =
      '<!-- sukuna-decisions:v2 -->\n# 手書きの題名\n- [保留] D1: "12 時間前" — "再検討" <!-- seq=4 -->\n手書きの文\n';
    expect(response.status).toBe(200);
    expect(decisionsResponseSchema.parse(await response.json())).toEqual({
      path: "docs/decisions/c.md",
      exists: true,
      hash: hash(updated),
      items: [edited],
      state,
    });
    expect(readFileSync(file, "utf8")).toBe(updated);
    expect(
      (await request("c/decisions", "PUT", { baseHash: hash(source), items: [item] })).status,
    ).toBe(409);
    expect(readFileSync(file, "utf8")).toBe(updated);
    expect(notices).toEqual(["c"]);
  });
  it("項目を消して同じ番号で戻し、外部エディターによる更新も読み直す", async () => {
    writeFileSync(file, line);
    expect((await request("c/decisions", "PUT", { baseHash: hash(line), items: [] })).status).toBe(
      200,
    );
    expect(readFileSync(file, "utf8")).toBe("<!-- sukuna-decisions:v2 -->\n");
    const restored = await request("c/decisions", "PUT", {
      baseHash: hash("<!-- sukuna-decisions:v2 -->\n"),
      items: [item],
    });
    expect(restored.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(
      '<!-- sukuna-decisions:v2 -->\n- [決定] D1: "24 時間前" <!-- seq=4 -->\n',
    );
    writeFileSync(file, line.replace("24", "48"));
    expect(await (await request("c/decisions")).json()).toEqual({
      path: "docs/decisions/c.md",
      exists: true,
      hash: hash(line.replace("24", "48")),
      items: [{ ...item, text: "48 時間前" }],
      state,
    });
  });
  it("ファイルが無い会話には空を返し、空の保存では作らない", async () => {
    const expected = { path: "docs/decisions/c.md", exists: false, hash: null, items: [], state };
    expect(await (await request("c/decisions")).json()).toEqual(expected);
    expect(
      await (await request("c/decisions", "PUT", { baseHash: null, items: [] })).json(),
    ).toEqual(expected);
  });
  it.each([false, true])(
    "ファイル形式 %s の上限内の項目だけを API に返し、契約外の原文は保存でも残す",
    async (quoted) => {
      const valid = {
        ...item,
        id: "D9007199254740993",
        text: "🙂".repeat(200),
        reason: "",
        seq: Number.MAX_SAFE_INTEGER,
      };
      const line = (text: string, reason: string | null, seq: string, id = "D9") =>
        `- [決定] ${id}: ${quoted ? JSON.stringify(text) : text}${reason === null ? "" : ` — ${quoted ? JSON.stringify(reason) : reason}`} <!-- seq=${seq} -->`;
      const invalid = [
        line("🙂".repeat(201), null, "1"),
        line("本文", "🙂".repeat(201), "1"),
        line("本文", null, "9007199254740993"),
        line("本文", null, "9".repeat(400)),
      ];
      const source = `${quoted ? "<!-- sukuna-decisions:v2 -->\n" : ""}${line(valid.text, valid.reason, String(valid.seq), valid.id)}\n${invalid.join("\n")}\n`;
      writeFileSync(file, source);
      const expected = {
        path: "docs/decisions/c.md",
        exists: true,
        hash: hash(source),
        items: [valid],
        state,
      };
      expect(decisionsResponseSchema.parse(await (await request("c/decisions")).json())).toEqual(
        expected,
      );
      const saved = await request("c/decisions", "PUT", { baseHash: hash(source), items: [valid] });
      expect(saved.status).toBe(200);
      const updated = readFileSync(file, "utf8");
      expect(decisionsResponseSchema.parse(await saved.json())).toEqual({
        ...expected,
        hash: hash(updated),
      });
      for (const original of invalid)
        expect(updated.split("\n").filter((line) => line === original)).toEqual([original]);
    },
  );
  it.each(
    [
      [{ ...item, text: "" }],
      [{ ...item, text: "字".repeat(201) }],
      [{ ...item, reason: "字".repeat(201) }],
      [item, item],
      [{ ...item, changedTo: "D9" }],
    ].map((items) => ({ items })),
  )("不正な項目 %j はファイルを書き換えず拒否する", async ({ items }) => {
    writeFileSync(file, line);
    const response = await request("c/decisions", "PUT", { baseHash: hash(line), items });
    expect(response.status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(line);
  });
  it.each([
    { text: "内容 — 注記", reason: null },
    { text: "内容 → D9", reason: null },
    { text: "内容 <!-- seq=99 -->", reason: null },
    { text: "改行\n行", reason: null },
    { text: "本文", reason: "理由 <!-- seq=99 -->" },
    {
      text: '本文 "引用"\n次の行 — 文 → D9 <!-- seq=90 -->',
      reason: '理由 "引用"\r\n次の行 — 理由 → D8 <!-- seq=80 -->',
    },
    { text: "本文", reason: "" },
  ])(
    "許可される内容と理由 %j を保存しても同じ項目として読み直せ、手書き行を残す",
    async (values) => {
      const source = `# 手書きの題名\n${line}手で書いた文\n`;
      writeFileSync(file, source);
      const edited = { ...item, ...values };
      const saved = await request("c/decisions", "PUT", {
        baseHash: hash(source),
        items: [edited],
      });
      expect(saved.status).toBe(200);
      expect(readFileSync(file, "utf8")).toBe(
        `<!-- sukuna-decisions:v2 -->\n# 手書きの題名\n- [決定] D1: ${JSON.stringify(edited.text)}${edited.reason === null ? "" : ` — ${JSON.stringify(edited.reason)}`} <!-- seq=4 -->\n手で書いた文\n`,
      );
      const expected = {
        path: "docs/decisions/c.md",
        exists: true,
        hash: hash(readFileSync(file, "utf8")),
        items: [edited],
        state,
      };
      expect(decisionsResponseSchema.parse(await saved.json())).toEqual(expected);
      const response = await request("c/decisions");
      expect(decisionsResponseSchema.parse(await response.json())).toEqual(expected);
    },
  );
  it("読めないプロジェクトのパスを内部エラーに含める", async () => {
    rmSync(root, { recursive: true });
    const response = await request("c/decisions");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal",
        message: `決まったことのファイルを読めませんでした (${root})。パスとアクセス権を確認してください。`,
      },
    });
  });
  it("作り直す番が無ければ競合、あればランナー未接続を返す", async () => {
    expect((await request("c/recap/rebuild", "POST")).status).toBe(409);
    event(6, "turn_end", {});
    const response = await request("c/recap/rebuild", "POST");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "runner_unavailable",
        message: "AI を動かすプロセスにつながりません。少し待ってから、もう一度操作してください。",
      },
    });
  });
  it("作り直しはランナーの内部 API に渡し、返った state を 202 で返す", async () => {
    event(6, "turn_end", {});
    const calls: unknown[] = [];
    deps = createRecapDependencies(
      () => database.db,
      {
        forward: async (...args) => {
          calls.push(args);
          return Response.json({ state: { ...state, updating: true } });
        },
      },
      (id) => notices.push(id),
    );
    const response = await request("c/recap/rebuild", "POST");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ state: { ...state, updating: true } });
    expect(calls).toEqual([["POST", "/conversations/c/recap/rebuild"]]);
    expect(
      database.sqlite
        .prepare("SELECT recap_seq,recap_failed_at FROM conversations WHERE id='c'")
        .get(),
    ).toEqual({ recap_seq: 0, recap_failed_at: null });
  });
  it.each([
    ["GET", "missing/recap"],
    ["GET", "missing/toc"],
    ["GET", "missing/decisions"],
    ["POST", "missing/read"],
    ["POST", "missing/recap/rebuild"],
    ["PATCH", "c/toc/9"],
  ])("%s %s は見つからない応答を返す", async (method, path) => {
    const response = await request(
      path,
      method,
      method === "PATCH"
        ? { title: "name", base: { title: "old", startSeq: 1 } }
        : method === "POST"
          ? {}
          : undefined,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "会話または章が見つかりません。会話を開き直してください。",
      },
    });
  });
  it.each([{ readSeq: -1 }, { position: 1.5 }])("不正な既読入力 %j は拒否する", async (body) => {
    expect((await request("c/read", "POST", body)).status).toBe(400);
    expect(
      database.sqlite
        .prepare("SELECT last_read_seq,last_position FROM conversations WHERE id='c'")
        .get(),
    ).toEqual({ last_read_seq: 0, last_position: null });
  });
});
