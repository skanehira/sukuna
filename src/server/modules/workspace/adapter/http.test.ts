import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ok } from "neverthrow";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../../shared/db/test-helpers";
import { createApp } from "../../../app";
import { mapSdkMessage } from "../../../../runner/modules/conversation/adapter/sdk-message-mapping";
import { outputEvents } from "../../../../runner/modules/conversation/domain/event-mapping";
import { incomingWith } from "../../identity/test-support";
import type { SearchClockPort } from "../domain/ports";
import {
  changesResponseSchema,
  contentSearchResponseSchema,
  fileContentResponseSchema,
  filesResponseSchema,
  nameSearchResponseSchema,
} from "../../../../shared/files";
import { createWorkspaceDependencies } from "./dependencies";

describe("会話のファイル API", () => {
  let home: string;
  let root: string;
  let cwd: string;
  let database: OpenedDatabase;

  beforeEach(() => {
    home = createTempHome();
    database = openMigratedDatabase(home);
    root = mkdtempSync(join(tmpdir(), "sukuna-files-"));
    cwd = join(root, "repo");
    mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/a.ts"), "あ😀 reserve\nreserve again\n");
    writeFileSync(join(cwd, "ignored.txt"), "reserve ignored\n");
    writeFileSync(join(cwd, ".hidden"), "--pre\n");
    writeFileSync(join(root, "outside.txt"), "outside secret\n");
    symlinkSync(join(root, "outside.txt"), join(cwd, "outside-link"));
    symlinkSync(join(cwd, "src/a.ts"), join(cwd, "inside-link"));
    database.sqlite
      .prepare(
        "INSERT INTO projects (id, name, path, default_branch) VALUES ('p', 'test', ?, 'main')",
      )
      .run(cwd);
    database.sqlite
      .prepare("INSERT INTO conversations (id, project_id, kind, cwd) VALUES ('c', 'p', 'chat', ?)")
      .run(cwd);
  });

  afterEach(() => {
    database.close();
    removeTempHome(home);
    rmSync(root, { recursive: true, force: true });
  });

  function request(path: string, clock?: SearchClockPort) {
    const app = createApp({
      build: "test",
      workspace: createWorkspaceDependencies(() => database.db, clock),
    });
    return app.request(path, undefined, incomingWith("127.0.0.1", 50000));
  }

  function requestListing(path: string, files: string[]) {
    const workspace = createWorkspaceDependencies(() => database.db);
    const app = createApp({
      build: "test",
      workspace: { ...workspace, search: { ...workspace.search, files: async () => ok(files) } },
    });
    return app.request(path, undefined, incomingWith("127.0.0.1", 50000));
  }

  it("ツリーは隠しファイルを含め、gitignore と .git を除いたパスを順に返す", async () => {
    const response = await request("/api/conversations/c/files");

    expect(response.status).toBe(200);
    expect(filesResponseSchema.parse(await response.json())).toEqual({
      files: [".gitignore", ".hidden", "inside-link", "outside-link", "src/a.ts"],
      truncated: false,
      changed: [],
    });
  });

  it.each(["--follow", "--no-ignore"])(
    "rg のユーザー設定 %s があっても一覧と検索の対象を広げない",
    async (option) => {
      const config = join(root, "ripgreprc");
      writeFileSync(config, `${option}\n`);
      const previous = process.env.RIPGREP_CONFIG_PATH;
      process.env.RIPGREP_CONFIG_PATH = config;
      try {
        const tree = await request("/api/conversations/c/files");
        expect(tree.status).toBe(200);
        expect(await tree.json()).toEqual({
          files: [".gitignore", ".hidden", "inside-link", "outside-link", "src/a.ts"],
          truncated: false,
          changed: [],
        });
        const names = await request("/api/conversations/c/search?mode=name&q=.");
        expect(names.status).toBe(200);
        expect(await names.json()).toEqual({
          mode: "name",
          query: ".",
          matches: [{ path: ".gitignore" }, { path: ".hidden" }, { path: "src/a.ts" }],
          truncated: false,
        });
        const content = await request(
          "/api/conversations/c/search?mode=content&q=reserve%7Csecret",
        );
        expect(content.status).toBe(200);
        expect(await content.json()).toEqual({
          mode: "content",
          query: "reserve|secret",
          matches: [
            { path: "src/a.ts", line: 1, col: 4, text: "あ😀 reserve" },
            { path: "src/a.ts", line: 2, col: 0, text: "reserve again" },
          ],
          truncated: false,
          timedOut: false,
        });
      } finally {
        if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
        else process.env.RIPGREP_CONFIG_PATH = previous;
      }
    },
  );

  it("改行を含む通常ファイルとリンクのパスをツリー・名前検索・読み取りで保つ", async () => {
    const file = "line\nbreak.txt";
    const link = "link\nbreak.txt";
    writeFileSync(join(cwd, file), "needle\n");
    symlinkSync(join(cwd, file), join(cwd, link));
    const tree = await request("/api/conversations/c/files");
    expect(tree.status).toBe(200);
    expect(await tree.json()).toEqual({
      files: [".gitignore", ".hidden", "inside-link", file, link, "outside-link", "src/a.ts"],
      truncated: false,
      changed: [],
    });
    const names = await request("/api/conversations/c/search?mode=name&q=break.txt");
    expect(names.status).toBe(200);
    expect(await names.json()).toEqual({
      mode: "name",
      query: "break.txt",
      matches: [{ path: file }, { path: link }],
      truncated: false,
    });
    for (const path of [file, link]) {
      const content = await request(
        `/api/conversations/c/files/content?path=${encodeURIComponent(path)}`,
      );
      expect(content.status).toBe(200);
      expect(await content.json()).toEqual({ path, kind: "text", size: 7, content: "needle\n" });
    }
  });

  it("文字のファイルは BOM を除き CRLF を LF にして返す", async () => {
    writeFileSync(join(cwd, "text.txt"), "\uFEFFあ\r\nnext\r\n");
    const response = await request("/api/conversations/c/files/content?path=text.txt");
    expect(response.status).toBe(200);
    expect(fileContentResponseSchema.parse(await response.json())).toEqual({
      path: "text.txt",
      kind: "text",
      size: 14,
      content: "あ\nnext\n",
    });
  });

  it.each([
    { size: 1_048_576, kind: "text" },
    { size: 1_048_577, kind: "too_large" },
  ])("$size バイトのファイルを $kind として返す", async ({ size, kind }) => {
    const content = "a".repeat(size);
    writeFileSync(join(cwd, "boundary.txt"), content);
    const response = await request("/api/conversations/c/files/content?path=boundary.txt");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "boundary.txt",
      kind,
      size,
      ...(kind === "text" ? { content } : {}),
    });
  });

  it.each([Buffer.from([65, 0, 66]), Buffer.from([0xc3, 0x28])])(
    "NUL または不正な UTF-8 のファイルは binary で中身を付けない",
    async (content) => {
      writeFileSync(join(cwd, "binary"), content);
      const response = await request("/api/conversations/c/files/content?path=binary");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        path: "binary",
        kind: "binary",
        size: content.length,
      });
    },
  );

  it.each([
    {
      path: "outside-link",
      status: 400,
      code: "invalid_input",
      message: "会話のディレクトリの外のファイルは開けません",
    },
    {
      path: ".git/config",
      status: 400,
      code: "invalid_input",
      message: "会話のディレクトリの外のファイルは開けません",
    },
    {
      path: "src",
      status: 400,
      code: "invalid_input",
      message: "ディレクトリは開けません。ファイルツリーで開いてください",
    },
    {
      path: "missing.txt",
      status: 404,
      code: "not_found",
      message: "ファイルがありません: missing.txt",
    },
  ])("中身を開くとき $path を $status で拒む", async ({ path, status, code, message }) => {
    const response = await request(
      `/api/conversations/c/files/content?path=${encodeURIComponent(path)}`,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message } });
  });

  it("中身の検索は無視されたファイルとリンクをたどらず文字単位の列と行を返す", async () => {
    const response = await request("/api/conversations/c/search?mode=content&q=reserve");
    expect(response.status).toBe(200);
    expect(contentSearchResponseSchema.parse(await response.json())).toEqual({
      mode: "content",
      query: "reserve",
      matches: [
        { path: "src/a.ts", line: 1, col: 4, text: "あ😀 reserve" },
        { path: "src/a.ts", line: 2, col: 0, text: "reserve again" },
      ],
      truncated: false,
      timedOut: false,
    });
  });

  it("--pre はオプションではなく検索パターンとして渡す", async () => {
    const response = await request("/api/conversations/c/search?mode=content&q=--pre");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "content",
      query: "--pre",
      matches: [{ path: ".hidden", line: 1, col: 0, text: "--pre" }],
      truncated: false,
      timedOut: false,
    });
  });

  it("名前の検索は空白で区切った全語を大文字小文字を区別せず照合する", async () => {
    const response = await request("/api/conversations/c/search?mode=name&q=SRC%20A.TS");
    expect(response.status).toBe(200);
    expect(nameSearchResponseSchema.parse(await response.json())).toEqual({
      mode: "name",
      query: "SRC A.TS",
      matches: [{ path: "src/a.ts" }],
      truncated: false,
    });
  });

  it.each(["content", "name"])("%s 検索で一致しなければ空配列を返す", async (mode) => {
    const response = await request(`/api/conversations/c/search?mode=${mode}&q=no-match`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode,
      query: "no-match",
      matches: [],
      truncated: false,
      ...(mode === "content" ? { timedOut: false } : {}),
    });
  });

  it.each(["mode=invalid&q=word", "mode=content&q=", "mode=name&q=%20%20"])(
    "検索の入力 %s は 400 を返す",
    async (query) => {
      const response = await request(`/api/conversations/c/search?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "invalid_input",
          message: query.startsWith("mode=invalid")
            ? "検索の種類は content または name を指定してください"
            : "検索する語を入れてください",
        },
      });
    },
  );

  it("壊れた正規表現は rg のエラーの先頭行を返す", async () => {
    const rg = spawnSync(
      "rg",
      ["--json", "--hidden", "-g", "!.git", "--max-columns", "500", "-e", "["],
      { cwd, encoding: "utf8" },
    );
    const response = await request("/api/conversations/c/search?mode=content&q=%5B");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_input", message: rg.stderr.split(/\r?\n/)[0] },
    });
  });

  it.each(["files", "files/content?path=src/a.ts", "search?mode=content&q=reserve", "changes"])(
    "会話が無いとき %s は 404 を返す",
    async (api) => {
      const response = await request(`/api/conversations/missing/${api}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "会話がありません" },
      });
    },
  );

  it.each(["files", "files/content?path=src/a.ts", "search?mode=content&q=reserve", "changes"])(
    "作業ディレクトリが無いとき %s は 409 を返す",
    async (api) => {
      rmSync(cwd, { recursive: true, force: true });
      const response = await request(`/api/conversations/c/${api}`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { code: "conflict", message: `この会話の作業ディレクトリがありません (${cwd})` },
      });
    },
  );

  it("差分はこの会話の記録だけを最初の seq 順に集計し作成と途中省略を保持する", async () => {
    const insert = database.sqlite.prepare(
      "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const hunk = {
      old_start: 1,
      old_lines: 1,
      new_start: 1,
      new_lines: 2,
      lines: ["-old", "+new", "+more"],
    };
    insert.run(
      "c",
      2,
      "diff",
      JSON.stringify({
        tool_use_id: "t2",
        path: "src/a.ts",
        change: "edit",
        hunks: [hunk],
        truncated: false,
      }),
      20,
    );
    insert.run(
      "c",
      1,
      "diff",
      JSON.stringify({
        tool_use_id: "t1",
        path: "created.txt",
        change: "create",
        hunks: [],
        content: "one\ntwo\n",
        truncated: true,
      }),
      10,
    );
    insert.run(
      "c",
      3,
      "diff",
      JSON.stringify({
        tool_use_id: "t3",
        path: "src/a.ts",
        change: "update",
        hunks: [{ ...hunk, lines: [" same", "-new", "+last"] }],
        truncated: false,
      }),
      30,
    );
    database.sqlite
      .prepare(
        "INSERT INTO conversations (id, project_id, kind, parent_conversation_id, cwd) VALUES ('thread', 'p', 'thread', 'c', ?)",
      )
      .run(cwd);
    insert.run(
      "thread",
      1,
      "diff",
      JSON.stringify({
        tool_use_id: "thread",
        path: "thread.txt",
        change: "create",
        hunks: [],
        content: "thread",
        truncated: false,
      }),
      40,
    );
    insert.run(
      "c",
      4,
      "tool_result",
      JSON.stringify({
        tool_use_id: "bash",
        content: "changed command.txt",
        is_error: false,
        truncated: false,
        bytes: 19,
      }),
      40,
    );
    writeFileSync(join(cwd, "command.txt"), "command only");
    const response = await request("/api/conversations/c/changes");
    expect(response.status).toBe(200);
    expect(changesResponseSchema.parse(await response.json())).toEqual({
      files: [
        {
          path: "created.txt",
          added: 2,
          removed: 0,
          changes: [
            {
              seq: 1,
              createdAt: 10,
              change: "create",
              hunks: [
                { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] },
              ],
              truncated: true,
            },
          ],
        },
        {
          path: "src/a.ts",
          added: 3,
          removed: 2,
          changes: [
            {
              seq: 2,
              createdAt: 20,
              change: "edit",
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 2,
                  lines: ["-old", "+new", "+more"],
                },
              ],
              truncated: false,
            },
            {
              seq: 3,
              createdAt: 30,
              change: "update",
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 2,
                  lines: [" same", "-new", "+last"],
                },
              ],
              truncated: false,
            },
          ],
        },
      ],
    });
    const tree = await request("/api/conversations/c/files");
    expect(await tree.json()).toEqual({
      files: [".gitignore", ".hidden", "command.txt", "inside-link", "outside-link", "src/a.ts"],
      truncated: false,
      changed: ["src/a.ts"],
    });
  });

  function recordSdkDiff(
    seq: number,
    pathField: "filePath" | "file_path",
    path: string,
    change: "edit" | "create" | "update",
  ) {
    const outputs = mapSdkMessage({
      type: "user",
      uuid: `sdk-${seq}`,
      message: { content: [{ type: "tool_result", tool_use_id: `t${seq}`, content: "ok" }] },
      tool_use_result: {
        [pathField]: path,
        type: change,
        ...(change === "create"
          ? { content: "created\n" }
          : {
              structuredPatch: [
                { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
              ],
            }),
      },
    });
    const diffs = outputs.flatMap(outputEvents).filter((event) => event.type === "diff");
    expect(diffs).toHaveLength(1);
    for (const event of diffs)
      database.sqlite
        .prepare(
          "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES ('c', ?, ?, ?, ?)",
        )
        .run(seq, event.type, JSON.stringify(event.payload), seq * 10);
  }

  it.each([
    { pathField: "filePath", change: "edit" },
    { pathField: "file_path", change: "edit" },
    { pathField: "filePath", change: "create" },
    { pathField: "file_path", change: "create" },
    { pathField: "filePath", change: "update" },
    { pathField: "file_path", change: "update" },
  ] as const)(
    "SDK の $pathField/$change の相対・絶対パスを同じファイルにそろえる",
    async ({ pathField, change }) => {
      ["./src/a.ts", join(cwd, "src/a.ts"), join(realpathSync(cwd), "src/a.ts")].forEach(
        (path, index) => recordSdkDiff(index + 1, pathField, path, change),
      );
      const tree = await request("/api/conversations/c/files");
      expect(tree.status).toBe(200);
      expect(await tree.json()).toEqual({
        files: [".gitignore", ".hidden", "inside-link", "outside-link", "src/a.ts"],
        truncated: false,
        changed: ["src/a.ts"],
      });
      const response = await request("/api/conversations/c/changes");
      expect(response.status).toBe(200);
      const changes = changesResponseSchema.parse(await response.json());
      expect(changes).toEqual({
        files: [
          {
            path: "src/a.ts",
            added: 3,
            removed: change === "create" ? 0 : 3,
            changes: [1, 2, 3].map((seq) => ({
              seq,
              createdAt: seq * 10,
              change,
              hunks:
                change === "create"
                  ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+created"] }]
                  : [
                      {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        lines: ["-old", "+new"],
                      },
                    ],
              truncated: false,
            })),
          },
        ],
      });
      const content = await request(
        `/api/conversations/c/files/content?path=${encodeURIComponent(changes.files[0].path)}`,
      );
      expect(content.status).toBe(200);
      expect(await content.json()).toEqual({
        path: "src/a.ts",
        kind: "text",
        size: 30,
        content: "あ😀 reserve\nreserve again\n",
      });
      const absolute = await request(
        `/api/conversations/c/files/content?path=${encodeURIComponent(join(cwd, "src/a.ts"))}`,
      );
      expect(absolute.status).toBe(400);
      expect(await absolute.json()).toEqual({
        error: { code: "invalid_input", message: "会話のディレクトリの外のファイルは開けません" },
      });
    },
  );

  it.each(["filePath", "file_path"] as const)(
    "SDK の %s で異なる編集種別・相対絶対パスが混じっても履歴と合計を保つ",
    async (pathField) => {
      recordSdkDiff(1, pathField, "src/a.ts", "edit");
      recordSdkDiff(2, pathField, join(cwd, "src/a.ts"), "update");
      recordSdkDiff(3, pathField, join(realpathSync(cwd), "src/a.ts"), "create");
      const response = await request("/api/conversations/c/changes");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        files: [
          {
            path: "src/a.ts",
            added: 3,
            removed: 2,
            changes: [
              ...(["edit", "update"] as const).map((change, index) => ({
                seq: index + 1,
                createdAt: (index + 1) * 10,
                change,
                hunks: [
                  { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
                ],
                truncated: false,
              })),
              {
                seq: 3,
                createdAt: 30,
                change: "create",
                hunks: [
                  { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+created"] },
                ],
                truncated: false,
              },
            ],
          },
        ],
      });
    },
  );

  it("作業ディレクトリの実体を保存した会話でも別名の絶対パスを統合する", async () => {
    const alias = join(root, "cwd-alias");
    symlinkSync(cwd, alias);
    database.sqlite
      .prepare("UPDATE conversations SET cwd = ? WHERE id = 'c'")
      .run(realpathSync(cwd));
    recordSdkDiff(1, "filePath", join(alias, "src/a.ts"), "edit");
    recordSdkDiff(2, "file_path", join(alias, "deleted/nested.txt"), "create");
    const changes = await request("/api/conversations/c/changes");
    expect(changes.status).toBe(200);
    expect(await changes.json()).toEqual({
      files: [
        {
          path: "src/a.ts",
          added: 1,
          removed: 1,
          changes: [
            {
              seq: 1,
              createdAt: 10,
              change: "edit",
              hunks: [
                { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
              ],
              truncated: false,
            },
          ],
        },
        {
          path: "deleted/nested.txt",
          added: 1,
          removed: 0,
          changes: [
            {
              seq: 2,
              createdAt: 20,
              change: "create",
              hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+created"] }],
              truncated: false,
            },
          ],
        },
      ],
    });
    const tree = await request("/api/conversations/c/files");
    expect(await tree.json()).toEqual({
      files: [".gitignore", ".hidden", "inside-link", "outside-link", "src/a.ts"],
      truncated: false,
      changed: ["src/a.ts"],
    });
  });

  it("削除済みの相対・絶対パスの差分は残し、外・.git・外を指すリンクの差分は含めない", async () => {
    const sibling = `${cwd}-sibling`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "secret"), "outside");
    symlinkSync(sibling, join(cwd, "outside-dir"));
    [
      "deleted/nested.txt",
      join(cwd, "deleted/nested.txt"),
      join(realpathSync(cwd), "deleted/nested.txt"),
    ].forEach((path, index) => recordSdkDiff(index + 1, "filePath", path, "edit"));
    [
      join(sibling, "secret"),
      ".git/config",
      join(cwd, ".git/config"),
      "outside-link",
      "outside-dir/deleted.txt",
      "../outside.txt",
    ].forEach((path, index) => recordSdkDiff(index + 4, "file_path", path, "edit"));
    const changes = await request("/api/conversations/c/changes");
    expect(changes.status).toBe(200);
    expect(await changes.json()).toEqual({
      files: [
        {
          path: "deleted/nested.txt",
          added: 3,
          removed: 3,
          changes: [1, 2, 3].map((seq) => ({
            seq,
            createdAt: seq * 10,
            change: "edit",
            hunks: [
              { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
            ],
            truncated: false,
          })),
        },
      ],
    });
    const tree = await request("/api/conversations/c/files");
    expect(await tree.json()).toEqual({
      files: [".gitignore", ".hidden", "inside-link", "outside-dir", "outside-link", "src/a.ts"],
      truncated: false,
      changed: [],
    });
  });

  it.each(
    (["inside", "outside", "git"] as const).flatMap((location) =>
      (["file", "directory"] as const).flatMap((kind) =>
        (["relative", "absolute", "alias"] as const).map((notation) => ({
          location,
          kind,
          notation,
        })),
      ),
    ),
  )(
    "$location の削除済み $kind を指すリンクと連鎖の $notation 記録は会話内の差分だけ残す",
    async ({ location, kind, notation }) => {
      const parent = location === "outside" ? `${cwd}-sibling` : cwd;
      mkdirSync(parent, { recursive: true });
      const target = join(parent, location === "git" ? ".git/deleted-target" : "deleted-target");
      if (kind === "directory") mkdirSync(target);
      writeFileSync(kind === "directory" ? join(target, "child.txt") : target, "old\n");
      symlinkSync(target, join(cwd, "dangling"));
      symlinkSync("dangling", join(cwd, "chain"));
      symlinkSync("removed-hop/../chain", join(cwd, "normalized-chain"));
      rmSync(target, { recursive: true });
      const alias = join(root, "cwd-alias");
      symlinkSync(cwd, alias);
      const paths = ["dangling", "chain", "normalized-chain"].map((path) =>
        kind === "directory" ? `${path}/child.txt` : path,
      );
      paths.forEach((path, index) =>
        recordSdkDiff(
          index + 1,
          "filePath",
          notation === "relative" ? path : join(notation === "alias" ? alias : cwd, path),
          "edit",
        ),
      );

      const changes = await request("/api/conversations/c/changes");

      expect(changes.status).toBe(200);
      expect(await changes.json()).toEqual({
        files:
          location === "inside"
            ? paths.map((path, index) => ({
                path,
                added: 1,
                removed: 1,
                changes: [
                  {
                    seq: index + 1,
                    createdAt: (index + 1) * 10,
                    change: "edit",
                    hunks: [
                      {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        lines: ["-old", "+new"],
                      },
                    ],
                    truncated: false,
                  },
                ],
              }))
            : [],
      });
      const tree = await request("/api/conversations/c/files");
      expect(tree.status).toBe(200);
      expect(await tree.json()).toEqual({
        files: [
          ".gitignore",
          ".hidden",
          "chain",
          "dangling",
          "inside-link",
          "normalized-chain",
          "outside-link",
          "src/a.ts",
        ],
        truncated: false,
        changed: [],
      });
    },
  );

  it.each(["relative", "absolute", "alias"] as const)(
    "循環リンクの %s 記録は差分から除き、会話内の通常の差分は返す",
    async (notation) => {
      symlinkSync("cycle-self", join(cwd, "cycle-self"));
      symlinkSync("cycle-b", join(cwd, "cycle-a"));
      symlinkSync("cycle-a", join(cwd, "cycle-b"));
      symlinkSync("cycle-growing/tail", join(cwd, "cycle-growing"));
      const alias = join(root, "cwd-alias");
      symlinkSync(cwd, alias);
      ["src/a.ts", "cycle-self", "cycle-a", "cycle-growing"].forEach((path, index) =>
        recordSdkDiff(
          index + 1,
          "file_path",
          notation === "relative" ? path : join(notation === "alias" ? alias : cwd, path),
          "edit",
        ),
      );

      const response = await request("/api/conversations/c/changes");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        files: [
          {
            path: "src/a.ts",
            added: 1,
            removed: 1,
            changes: [
              {
                seq: 1,
                createdAt: 10,
                change: "edit",
                hunks: [
                  { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
                ],
                truncated: false,
              },
            ],
          },
        ],
      });
    },
  );

  it("名前の検索は 200 件まで返し、201 件目があれば truncated にする", async () => {
    const paths = (count: number) =>
      Array.from({ length: count }, (_, i) => `name-${String(i).padStart(3, "0")}.txt`);
    const matches = paths(200).map((path) => ({ path }));
    const search = (files: string[]) =>
      requestListing("/api/conversations/c/search?mode=name&q=name-", files);
    const first = await search(paths(200));
    expect(await first.json()).toEqual({ mode: "name", query: "name-", matches, truncated: false });
    const next = await search(paths(201));
    expect(await next.json()).toEqual({ mode: "name", query: "name-", matches, truncated: true });
  });

  it("中身の検索は一致する行を 1000 件まで返し、1001 件目があれば truncated にする", async () => {
    writeFileSync(join(cwd, "many.txt"), "hit\n".repeat(1000));
    const matches = Array.from({ length: 1000 }, (_, i) => ({
      path: "many.txt",
      line: i + 1,
      col: 0,
      text: "hit",
    }));
    const first = await request("/api/conversations/c/search?mode=content&q=hit");
    expect(await first.json()).toEqual({
      mode: "content",
      query: "hit",
      matches,
      truncated: false,
      timedOut: false,
    });
    writeFileSync(join(cwd, "many.txt"), "hit\n".repeat(1001));
    const next = await request("/api/conversations/c/search?mode=content&q=hit");
    expect(await next.json()).toEqual({
      mode: "content",
      query: "hit",
      matches,
      truncated: true,
      timedOut: false,
    });
  });

  it.each([9_999, 10_000])(
    "中身の検索の時計が $0 ミリ秒進むと 10 秒の境界で rg を止める",
    async (elapsed) => {
      const clock: SearchClockPort = {
        schedule: (callback, milliseconds) => {
          if (milliseconds <= elapsed) queueMicrotask(callback);
          return () => {};
        },
      };
      const response = await request("/api/conversations/c/search?mode=content&q=reserve", clock);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        mode: "content",
        query: "reserve",
        matches:
          elapsed < 10_000
            ? [
                { path: "src/a.ts", line: 1, col: 4, text: "あ😀 reserve" },
                { path: "src/a.ts", line: 2, col: 0, text: "reserve again" },
              ]
            : [],
        truncated: false,
        timedOut: elapsed >= 10_000,
      });
    },
  );

  it("検索結果の本文は 500 文字で切り、空白を含む正規表現をそのまま使う", async () => {
    const text = "あ".repeat(500) + " reserve again";
    writeFileSync(join(cwd, "long.txt"), text);
    const response = await request(
      "/api/conversations/c/search?mode=content&q=(%3Fi)reserve%20again",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "content",
      query: "(?i)reserve again",
      matches: [
        { path: "long.txt", line: 1, col: 501, text: "あ".repeat(500) },
        { path: "src/a.ts", line: 2, col: 0, text: "reserve again" },
      ],
      truncated: false,
      timedOut: false,
    });
  });

  it("ツリーは 20000 件までをパス順に返し、名前の検索はその後のパスも探せる", async () => {
    const paths = (count: number) =>
      Array.from({ length: count }, (_, i) => `bulk/${String(i).padStart(5, "0")}.txt`);

    const boundary = await requestListing("/api/conversations/c/files", paths(20_000));
    expect(await boundary.json()).toEqual({
      files: paths(20_000),
      truncated: false,
      changed: [],
    });
    const response = await requestListing("/api/conversations/c/files", paths(20_001));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      files: paths(20_000),
      truncated: true,
      changed: [],
    });
    const name = await requestListing(
      "/api/conversations/c/search?mode=name&q=20000",
      paths(20_001),
    );
    expect(await name.json()).toEqual({
      mode: "name",
      query: "20000",
      matches: [{ path: "bulk/20000.txt" }],
      truncated: false,
    });
  });
  it.each([
    { index: 7_999, kind: "binary" },
    { index: 8_000, kind: "text" },
  ])("NUL の検査は先頭 8000 バイトだけに適用する ($index)", async ({ index, kind }) => {
    const bytes = Buffer.alloc(8_001, 65);
    bytes[index] = 0;
    writeFileSync(join(cwd, "nul-boundary"), bytes);
    const response = await request("/api/conversations/c/files/content?path=nul-boundary");
    expect(await response.json()).toEqual({
      path: "nul-boundary",
      kind,
      size: 8_001,
      ...(kind === "text" ? { content: bytes.toString("utf8") } : {}),
    });
  });

  it("会話の中を指すリンクは元のパスで中身を返し、空ファイルも text を返す", async () => {
    writeFileSync(join(cwd, "src/a.ts"), "");
    const response = await request("/api/conversations/c/files/content?path=inside-link");
    expect(await response.json()).toEqual({
      path: "inside-link",
      kind: "text",
      size: 0,
      content: "",
    });
  });

  it("AI が変えた一覧の印は無視された既存ファイルも含め、無いファイルと外のリンクを除く", async () => {
    const insert = database.sqlite.prepare(
      "INSERT INTO conversation_events (conversation_id, seq, type, payload, created_at) VALUES ('c', ?, 'diff', ?, 1)",
    );
    ["ignored.txt", "missing.txt", "outside-link", "src/a.ts"].forEach((path, index) =>
      insert.run(
        index + 1,
        JSON.stringify({
          tool_use_id: `t${index}`,
          path,
          change: "edit",
          hunks: [],
          truncated: false,
        }),
      ),
    );
    const response = await request("/api/conversations/c/files");
    expect(await response.json()).toEqual({
      files: [".gitignore", ".hidden", "inside-link", "outside-link", "src/a.ts"],
      truncated: false,
      changed: ["ignored.txt", "src/a.ts"],
    });
  });
});
