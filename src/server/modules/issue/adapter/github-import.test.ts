import { execFileSync } from "node:child_process";
import { incomingWith } from "../../identity/test-support";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { createApp } from "../../../app";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../../shared/db/test-helpers";
import { conversations, issues, projects } from "../../../../shared/db/schema";
import { newIssue } from "../../../../shared/issue/rules";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import { createGithubImportDependencies } from "./github-import-routes";

let home: string;
let database: OpenedDatabase;
function git(...args: string[]) {
  return execFileSync("git", args, {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}
beforeEach(() => {
  home = createTempHome();
  git("init", "-q");
  git("remote", "add", "origin", "git@github.com:example/repo.git");
  database = openMigratedDatabase(home);
  database.db
    .insert(projects)
    .values([
      {
        id: "github",
        name: "GitHub",
        path: home,
        usesGithub: true,
        defaultBranch: "main",
        confirmBeforeMergeDefault: true,
      },
      { id: "local", name: "ローカル", path: home + "/local", defaultBranch: "main" },
    ])
    .run();
  database.db
    .insert(issues)
    .values({ ...newIssue("existing", "github", 1, 10, true), githubNumber: 12 })
    .run();
});
afterEach(() => {
  database.close();
  removeTempHome(home);
});

const remote = (number: number) => ({
  number,
  title: "課題 " + number,
  body: "取り込む本文",
  state: "OPEN",
  url: "https://github.com/example/repo/issues/" + number,
});
const missing = "GraphQL: Could not resolve to an Issue or PullRequest with the number of 404.";
const unavailable = "gh: request failed";
const success = (value: unknown) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify(value) });

function fixture(gh: GhRunner) {
  const changed: string[][] = [];
  let nextId = 0;
  const app = createApp({
    build: "test",
    resolveIdentity: async () => ({
      allowed: true,
      identity: { login: "tester", device: "local" },
    }),
    githubImport: createGithubImportDependencies(() => database.db, gh, {
      now: () => 1000,
      id: () => "imported-" + ++nextId,
      changed: (id, projectId) => changed.push([id, projectId]),
      log: () => {},
    }),
  });
  return {
    changed,
    list: (project = "github") =>
      app.request(
        "/api/projects/" + project + "/github-issues",
        undefined,
        incomingWith("127.0.0.1", 5000),
      ),
    post: (numbers: number[], project = "github") =>
      app.request(
        "/api/projects/" + project + "/github-import",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ numbers }),
        },
        incomingWith("127.0.0.1", 5000),
      ),
  };
}

it("選択したopenだけを下書きに保存し、飛ばした理由を番号ごとに返す", async () => {
  const f = fixture({
    async run(args) {
      const number = Number(args[2]);
      if (number === 404) return { exitCode: 1, stdout: "", stderr: missing };
      if (number === 412) return { exitCode: 1, stdout: "", stderr: unavailable };
      const issue = remote(number);
      if (number === 18) issue.state = "CLOSED";
      if (number === 20) issue.body = "長".repeat(50_000);
      return success(issue);
    },
  });
  const response = await f.post([12, 17, 18, 404, 20, 412, 17]);
  expect({ status: response.status, value: await response.json() }).toEqual({
    status: 200,
    value: {
      imported: [{ githubNumber: 17, issueId: "imported-1", issueNumber: 2 }],
      skipped: [
        { githubNumber: 12, reason: "already_imported" },
        { githubNumber: 18, reason: "not_open" },
        { githubNumber: 404, reason: "not_found" },
        { githubNumber: 20, reason: "too_long" },
        { githubNumber: 412, reason: "not_found" },
      ],
    },
  });
  expect(database.db.select().from(issues).all()).toEqual([
    { ...newIssue("existing", "github", 1, 10, true), githubNumber: 12 },
    {
      ...newIssue("imported-1", "github", 2, 1000, true),
      githubNumber: 17,
      title: "課題 17",
      body: "取り込む本文\n\nGitHub から取り込んだ issue: https://github.com/example/repo/issues/17",
    },
  ]);
  expect({
    notices: f.changed,
    conversations: database.db.select().from(conversations).all(),
  }).toEqual({
    notices: [["imported-1", "github"]],
    conversations: [],
  });
});

it("GitHub候補を新しい番号順で返し、200件と取り込み済みを知らせる", async () => {
  const date = "2026-11-28T02:00:00Z";
  const rows = Array.from({ length: 200 }, (_, i) => {
    const { number, title, url } = remote(i + 1);
    return { number, title, url, labels: [{ name: "label" }], createdAt: date };
  });
  const f = fixture({
    async run() {
      return success(rows);
    },
  });
  const response = await f.list();
  expect({ status: response.status, value: await response.json() }).toEqual({
    status: 200,
    value: {
      truncated: true,
      issues: rows.toReversed().map((row) => ({
        ...row,
        labels: ["label"],
        createdAt: Date.parse(date),
        imported: row.number === 12,
      })),
    },
  });
});

it("GitHubを使わない場合は候補も取り込みも409になり、外部取得を始めない", async () => {
  const calls: string[][] = [];
  const f = fixture({
    async run(args) {
      calls.push(args);
      return success([]);
    },
  });
  const responses = await Promise.all([f.list("local"), f.post([17], "local")]);
  const expected = {
    status: 409,
    value: { error: { code: "conflict", message: "このプロジェクトは GitHub を使いません。" } },
  };
  expect(
    await Promise.all(responses.map(async (r) => ({ status: r.status, value: await r.json() }))),
  ).toEqual([expected, expected]);
  expect(calls).toEqual([]);
});

it("GitHubに接続できないと候補と取り込みは502で最初のエラーを返す", async () => {
  const f = fixture({
    async run() {
      return { exitCode: 1, stdout: "", stderr: unavailable + "\nsecond line" };
    },
  });
  const responses = await Promise.all([f.list(), f.post([17])]);
  const expected = {
    status: 502,
    value: {
      error: {
        code: "github_unavailable",
        message:
          "gh: request failed。ターミナルで gh auth login を実行し、もう一度試してください。",
      },
    },
  };
  expect(
    await Promise.all(responses.map(async (r) => ({ status: r.status, value: await r.json() }))),
  ).toEqual([expected, expected]);
});

it("同じ課題を並行して取り込んでも下書きと通知は1件だけになる", async () => {
  let reached = 0;
  let release = () => {};
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  const f = fixture({
    async run() {
      reached += 1;
      if (reached === 2) release();
      await waiting;
      return success(remote(17));
    },
  });
  const responses = await Promise.all([f.post([17]), f.post([17])]);
  const bodies = await Promise.all(
    responses.map(async (r) => ({ status: r.status, body: await r.json() })),
  );
  expect(bodies).toEqual([
    {
      status: 200,
      body: {
        imported: [{ githubNumber: 17, issueId: "imported-1", issueNumber: 2 }],
        skipped: [],
      },
    },
    {
      status: 200,
      body: { imported: [], skipped: [{ githubNumber: 17, reason: "already_imported" }] },
    },
  ]);
  expect(f.changed).toEqual([["imported-1", "github"]]);
});

it("CLIの既定とは別のSSH originを候補と取り込みの両方で使う", async () => {
  git("remote", "set-url", "origin", "ssh://git@SSH.GITHUB.COM:443/registered/shop.git");
  git("remote", "add", "upstream", "https://github.com/other/shop.git");
  git("config", "--local", "remote.upstream.gh-resolved", "base");
  const targets: string[] = [];
  const createdAt = "2026-11-28T02:00:00Z";
  const candidate = {
    number: 17,
    title: "登録先の課題",
    url: "https://github.com/registered/shop/issues/17",
  };
  const f = fixture({
    async run(args) {
      const repoAt = args.indexOf("--repo");
      const target =
        repoAt === -1 && git("config", "--local", "--get", "remote.upstream.gh-resolved") === "base"
          ? "github.com/other/shop"
          : args[repoAt + 1]!;
      targets.push(target);
      const row =
        target === "github.com/registered/shop"
          ? candidate
          : {
              ...candidate,
              title: "別リポジトリの課題",
              url: "https://github.com/other/shop/issues/17",
            };
      return args[1] === "list"
        ? success([{ ...row, labels: [{ name: "確認" }], createdAt }])
        : success({ ...row, body: "取り込む本文", state: "OPEN" });
    },
  });
  const list = await f.list();
  const imported = await f.post([17]);
  expect({
    listStatus: list.status,
    list: await list.json(),
    importStatus: imported.status,
    imported: await imported.json(),
    targets,
    draft: database.sqlite
      .prepare("SELECT title,body,github_number FROM issues WHERE id='imported-1'")
      .get(),
  }).toEqual({
    listStatus: 200,
    list: {
      truncated: false,
      issues: [
        { ...candidate, labels: ["確認"], createdAt: Date.parse(createdAt), imported: false },
      ],
    },
    importStatus: 200,
    imported: {
      imported: [{ githubNumber: 17, issueId: "imported-1", issueNumber: 2 }],
      skipped: [],
    },
    targets: ["github.com/registered/shop", "github.com/registered/shop"],
    draft: {
      title: candidate.title,
      body: "取り込む本文\n\nGitHub から取り込んだ issue: " + candidate.url,
      github_number: 17,
    },
  });
});

it("不存在と同時に通信エラーがあり実issueを取得できなければ502になる", async () => {
  const f = fixture({
    async run(args) {
      return { exitCode: 1, stdout: "", stderr: Number(args[2]) === 404 ? missing : unavailable };
    },
  });
  const mixed = await f.post([404, 412]);
  const absent = await f.post([404]);
  expect({
    mixedStatus: mixed.status,
    mixed: await mixed.json(),
    absentStatus: absent.status,
    absent: await absent.json(),
    notices: f.changed,
  }).toEqual({
    mixedStatus: 502,
    mixed: {
      error: {
        code: "github_unavailable",
        message:
          "gh: request failed。ターミナルで gh auth login を実行し、もう一度試してください。",
      },
    },
    absentStatus: 200,
    absent: { imported: [], skipped: [{ githubNumber: 404, reason: "not_found" }] },
    notices: [],
  });
});

it("別件の取得待ちに取り下げられた番号は取り込み済みと返し、再試行で取り込める", async () => {
  let started = () => {};
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: number[] = [];
  const f = fixture({
    async run(args) {
      const number = Number(args[2]);
      calls.push(number);
      if (number === 17) {
        started();
        await held;
      }
      return success(remote(number));
    },
  });
  const pending = f.post([12, 17]);
  await ready;
  database.sqlite
    .prepare("UPDATE issues SET state='withdrawn', github_number=NULL WHERE id='existing'")
    .run();
  release();
  const first = await pending;
  const second = await f.post([12]);
  expect({
    statuses: [first.status, second.status],
    first: await first.json(),
    second: await second.json(),
    calls,
    notices: f.changed,
  }).toEqual({
    statuses: [200, 200],
    first: {
      imported: [{ githubNumber: 17, issueId: "imported-1", issueNumber: 2 }],
      skipped: [{ githubNumber: 12, reason: "already_imported" }],
    },
    second: {
      imported: [{ githubNumber: 12, issueId: "imported-2", issueNumber: 3 }],
      skipped: [],
    },
    calls: [17, 12],
    notices: [
      ["imported-1", "github"],
      ["imported-2", "github"],
    ],
  });
});

it("originを消したプロジェクトで、CLIの既定リポジトリに切り替わらない", async () => {
  git("remote", "remove", "origin");
  const calls: string[][] = [];
  const f = fixture({
    async run(args) {
      calls.push(args);
      return success([]);
    },
  });
  const response = await f.list();
  expect({ status: response.status, body: await response.json(), calls }).toEqual({
    status: 502,
    body: {
      error: {
        code: "github_unavailable",
        message:
          "GitHub のリポジトリを確認できませんでした。origin に GitHub のリポジトリを設定してください。",
      },
    },
    calls: [],
  });
});
