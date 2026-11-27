import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDecisionFileStore } from "./decision-file-store";
import { parseDecisionFile, replaceDecisionItems } from "./decision-file";

describe("決まったことのファイルの保存", () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sukuna-decisions-"));
    file = join(root, "docs/decisions/c.md");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const item = {
    id: "D1",
    kind: "decision" as const,
    text: "決めたこと",
    reason: null,
    seq: 4,
    changedTo: null,
  };
  it("最初の項目を足すときに会話の題名と番号でファイルを作る", () => {
    const store = createDecisionFileStore();
    const saved = store.update(root, "c", "予約 API", (content) =>
      replaceDecisionItems(content, [item]),
    );
    const content =
      "# 決まったこと: 予約 API\n\n- 種別: 決定台帳\n- 会話: c\n\n- [決定] D1: 決めたこと <!-- seq=4 -->\n";
    expect(saved._unsafeUnwrap()).toEqual({
      path: "docs/decisions/c.md",
      exists: true,
      hash: createHash("sha256").update(content).digest("hex"),
      content,
      items: [item],
    });
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(readdirSync(dirname(file))).toEqual(["c.md"]);
  });
  function racingStore(changes: number) {
    let writes = 0;
    return {
      store: createDecisionFileStore({
        read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
        directory: (path) => {
          statSync(path);
        },
        write: (path, content) => {
          writeFileSync(path, content, { flag: "wx" });
          writes += 1;
          if (writes <= changes) writeFileSync(file, `手書き ${writes}\n`);
        },
        rename: renameSync,
        remove: (path) => rmSync(path, { force: true }),
        temporary: (path) => `${path}.tmp`,
      }),
      writes: () => writes,
    };
  }
  it("比較する直前に変わると読み直して当て直し、3 回目に保存できる", () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "元の文\n");
    const { store, writes } = racingStore(2);
    const saved = store.update(root, "c", "予約 API", (content) =>
      replaceDecisionItems(content, [item]),
    );
    expect(saved._unsafeUnwrap().items).toEqual([item]);
    expect(readFileSync(file, "utf8")).toBe("手書き 2\n- [決定] D1: 決めたこと <!-- seq=4 -->\n");
    expect(writes()).toBe(3);
    expect(readdirSync(dirname(file))).toEqual(["c.md"]);
  });
  it("3 回続けて変わると外部変更を残したまま競合で止め、一時ファイルを消す", () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "元の文\n");
    const { store, writes } = racingStore(3);
    const saved = store.update(root, "c", "予約 API", (content) =>
      replaceDecisionItems(content, [item]),
    );
    expect(saved._unsafeUnwrapErr()).toEqual({
      code: "conflict",
      message: "決まったことのファイルの変更が続いています。読み直して、もう一度保存してください。",
    });
    expect(readFileSync(file, "utf8")).toBe("手書き 3\n");
    expect(writes()).toBe(3);
    expect(readdirSync(dirname(file))).toEqual(["c.md"]);
  });
  it("baseHash がある編集は途中の外部変更にも競合を返す", () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "元の文\n");
    const { store, writes } = racingStore(1);
    const original = store.read(root, "c")._unsafeUnwrap();
    const saved = store.update(
      root,
      "c",
      "予約 API",
      (content) => replaceDecisionItems(content, [item]),
      original.hash,
    );
    expect(saved._unsafeUnwrapErr()).toEqual({
      code: "conflict",
      message: "決まったことのファイルが変わりました。読み直して、もう一度保存してください。",
    });
    expect(readFileSync(file, "utf8")).toBe("手書き 1\n");
    expect(writes()).toBe(1);
  });
  it("一時ファイルの置換に失敗しても元のファイルと手書き行を残す", () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "元の文\n");
    const store = createDecisionFileStore({
      read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      directory: (path) => {
        statSync(path);
      },
      write: (path, content) => writeFileSync(path, content),
      rename: () => {
        throw new Error("read only");
      },
      remove: (path) => rmSync(path, { force: true }),
      temporary: (path) => `${path}.tmp`,
    });
    expect(
      store
        .update(root, "c", "予約 API", (content) => replaceDecisionItems(content, [item]))
        ._unsafeUnwrapErr(),
    ).toEqual({
      code: "internal",
      message: `決まったことのファイルを保存できませんでした (${file})。パスとアクセス権を確認してください。`,
    });
    expect(readFileSync(file, "utf8")).toBe("元の文\n");
    expect(readdirSync(dirname(file))).toEqual(["c.md"]);
  });
  it("項目を足して直しても理由に含む区切りの文は保たれる", () => {
    const store = createDecisionFileStore();
    const decision = { ...item, reason: "理由 — 補足" };
    const saved = store.update(root, "c", "予約 API", (content) =>
      replaceDecisionItems(content, [decision]),
    );
    expect(parseDecisionFile(saved._unsafeUnwrap().content)).toEqual([decision]);
  });
});
