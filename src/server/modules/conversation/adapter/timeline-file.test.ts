import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createTempHome, removeTempHome } from "../../../../shared/db/test-helpers";
import { createTimelineFilePort } from "./timeline-file";

let configDir: string;
let file: string;
beforeEach(() => {
  configDir = createTempHome();
  mkdirSync(join(configDir, "timeline/sessions"), { recursive: true });
  file = join(configDir, "timeline/sessions/session.json");
});
afterEach(() => removeTempHome(configDir));
const empty = { version: 1, journal: [], reports: [], comments: [] };

describe("タイムラインのファイル", () => {
  it("未作成は null を返し comments の無いファイルも読み取る", async () => {
    const reader = createTimelineFilePort({ configDir, sleep: async () => {} });
    expect(await reader.read("session")).toEqual({ file: null, readError: null });
    writeFileSync(file, JSON.stringify({ version: 1, journal: [], reports: [] }));
    expect(await reader.read("session")).toEqual({ file: empty, readError: null });
  });

  it.each([
    ["{", "タイムラインのファイルの形式が正しくありません。"],
    [
      JSON.stringify({ version: 2, journal: [], reports: [] }),
      "タイムラインのファイルの形式が正しくありません。",
    ],
    [
      JSON.stringify({ version: 1, journal: {}, reports: [] }),
      "タイムラインのファイルの形式が正しくありません。",
    ],
    [
      JSON.stringify({ version: 1, journal: [], reports: {} }),
      "タイムラインのファイルの形式が正しくありません。",
    ],
    [" ".repeat(4 * 1024 * 1024 + 1), "タイムラインのファイルが 4 MiB を超えています。"],
  ])("壊れたファイルは最後に読めた内容と理由を返す", async (text, readError) => {
    const reader = createTimelineFilePort({ configDir, sleep: async () => {} });
    writeFileSync(file, JSON.stringify(empty));
    expect(await reader.read("session")).toEqual({ file: empty, readError: null });
    writeFileSync(file, text);
    expect(await reader.read("session")).toEqual({ file: empty, readError });
    expect(await reader.read("other")).toEqual({ file: null, readError: null });
    writeFileSync(file, JSON.stringify({ ...empty, reports: [{ at: 1, text: "復旧" }] }));
    expect(await reader.read("session")).toEqual({
      file: { ...empty, reports: [{ at: 1, text: "復旧" }] },
      readError: null,
    });
  });

  it("書き込み途中の形式エラーは 200 ms 後に 1 回だけ読み直す", async () => {
    const waits: number[] = [];
    const reader = createTimelineFilePort({
      configDir,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        writeFileSync(file, JSON.stringify(empty));
      },
    });
    writeFileSync(file, "{");
    expect(await reader.read("session")).toEqual({ file: empty, readError: null });
    expect(waits).toEqual([200]);
  });

  it("復旧しないときの読み直しは 1 回で止める", async () => {
    const waits: number[] = [];
    const reader = createTimelineFilePort({
      configDir,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    writeFileSync(file, "{");
    expect(await reader.read("session")).toEqual({
      file: null,
      readError: "タイムラインのファイルの形式が正しくありません。",
    });
    expect(waits).toEqual([200]);
  });

  it("4 MiB ちょうどを読み session id で設定ディレクトリから抜けない", async () => {
    const reader = createTimelineFilePort({ configDir, sleep: async () => {} });
    const content = JSON.stringify(empty);
    writeFileSync(file, content + " ".repeat(4 * 1024 * 1024 - Buffer.byteLength(content)));
    expect(await reader.read("session")).toEqual({ file: empty, readError: null });
    expect(await reader.read("../session")).toEqual({
      file: null,
      readError: "タイムラインの session id が正しくありません。",
    });
  });
});

it("正常・未作成・容量超過では読み直しを待たない", async () => {
  const waits: number[] = [];
  const reader = createTimelineFilePort({
    configDir,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  expect(await reader.read("missing")).toEqual({ file: null, readError: null });
  writeFileSync(file, JSON.stringify(empty));
  expect(await reader.read("session")).toEqual({ file: empty, readError: null });
  writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
  expect(await reader.read("session")).toEqual({
    file: empty,
    readError: "タイムラインのファイルが 4 MiB を超えています。",
  });
  expect(waits).toEqual([]);
});
it("削除されたファイルのキャッシュを消し、その後の破損で古い木を返さない", async () => {
  const reader = createTimelineFilePort({ configDir, sleep: async () => {} });
  writeFileSync(file, JSON.stringify(empty));
  expect(await reader.read("session")).toEqual({ file: empty, readError: null });
  unlinkSync(file);
  expect(await reader.read("session")).toEqual({ file: null, readError: null });
  writeFileSync(file, "{");
  expect(await reader.read("session")).toEqual({
    file: null,
    readError: "タイムラインのファイルの形式が正しくありません。",
  });
});
it("ディレクトリは未作成と区別し、再試行せず読取り失敗を返す", async () => {
  const waits: number[] = [];
  const reader = createTimelineFilePort({
    configDir,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  mkdirSync(file);
  expect(await reader.read("session")).toEqual({
    file: null,
    readError: "タイムラインのファイルを読めませんでした。",
  });
  expect(waits).toEqual([]);
});
it("有効なIDの後ろに不正な文字があれば拒否する", async () => {
  expect(
    await createTimelineFilePort({ configDir, sleep: async () => {} }).read("session/../session"),
  ).toEqual({ file: null, readError: "タイムラインの session id が正しくありません。" });
});
