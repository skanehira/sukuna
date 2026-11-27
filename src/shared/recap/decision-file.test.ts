import { describe, expect, it } from "vite-plus/test";
import {
  nextDecisionId,
  parseDecisionFile,
  replaceDecisionItems,
  serializeDecision,
  type DecisionItem,
} from "./decision-file";

describe("決まったことのファイル", () => {
  const items = [
    {
      id: "D2",
      kind: "decision" as const,
      text: "24 時間前",
      reason: null,
      seq: 9,
      changedTo: "D5",
    },
    {
      id: "D3",
      kind: "rejected" as const,
      text: "独自認証",
      reason: "既存を使う",
      seq: null,
      changedTo: null,
    },
    {
      id: "D5",
      kind: "pending" as const,
      text: "12 時間前",
      reason: null,
      seq: 40,
      changedTo: null,
    },
  ];
  const lines = [
    "- [決定] D2: 24 時間前 → D5 <!-- seq=9 -->",
    "- [棄却] D3: 独自認証 — 既存を使う",
    "- [保留] D5: 12 時間前 <!-- seq=40 -->",
  ];
  it("3 種類・理由・変わった先・根拠を読み、同じ行に組み立てる", () => {
    expect(parseDecisionFile(lines.join("\n"))).toEqual(items);
    expect(items.map(serializeDecision)).toEqual([
      '- [決定] D2: "24 時間前" → D5 <!-- seq=9 -->',
      '- [棄却] D3: "独自認証" — "既存を使う"',
      '- [保留] D5: "12 時間前" <!-- seq=40 -->',
    ]);
    expect(nextDecisionId(lines.join("\n"))).toBe("D6");
    expect(nextDecisionId("手で書いた文\n- [未知] D90: 読まない")).toBe("D1");
  });
  it("空文字の理由も保存後に同じ項目として読み直せる", () => {
    const item = { ...items[0], reason: "" };
    expect(parseDecisionFile(`<!-- sukuna-decisions:v2 -->\n${serializeDecision(item)}`)).toEqual([
      item,
    ]);
  });
  it("項目を並べ替え・削除・復元しても手書き行と改行を残す", () => {
    const source = `# 台帳\r\n\r\n${lines[0]}\r\n手で書いた文\r\n${lines[1]}\r\n末尾`;
    expect(replaceDecisionItems(source, [items[2], items[0]])).toBe(
      `<!-- sukuna-decisions:v2 -->\r\n# 台帳\r\n\r\n- [保留] D5: "12 時間前" <!-- seq=40 -->\r\n手で書いた文\r\n- [決定] D2: "24 時間前" → D5 <!-- seq=9 -->\r\n末尾`,
    );
    expect(replaceDecisionItems(source, [])).toBe(
      "<!-- sukuna-decisions:v2 -->\r\n# 台帳\r\n\r\n手で書いた文\r\n末尾",
    );
  });
  it("版の印が無い引用符を含む本文と理由を旧来の文字として移行する", () => {
    const source =
      '- [棄却] D1: "本文" — "理由" → D2 <!-- seq=4 -->\n手書きの文\n- [決定] D2: 次\n';
    const legacy: DecisionItem[] = [
      { id: "D1", kind: "rejected", text: '"本文"', reason: '"理由"', changedTo: "D2", seq: 4 },
      { id: "D2", kind: "decision", text: "次", reason: null, changedTo: null, seq: null },
    ];
    expect(parseDecisionFile(source)).toEqual(legacy);
    const migrated = replaceDecisionItems(source, legacy);
    expect(migrated).toBe(
      '<!-- sukuna-decisions:v2 -->\n- [棄却] D1: "\\"本文\\"" — "\\"理由\\"" → D2 <!-- seq=4 -->\n手書きの文\n- [決定] D2: "次"\n',
    );
    expect(parseDecisionFile(migrated)).toEqual(legacy);
    expect(nextDecisionId(migrated)).toBe("D3");
  });
  it.each([
    '- [決定] D1: "閉じない',
    '- [決定] D1: "不正\\q"',
    '- [決定] D1: "本文" — 引用なし',
    '- [決定] D1: ""',
    '- [決定] D1: "   "',
    "- [決定] D1: 本文",
  ])("新版の形に合わない行 %s を手書きのまま残す", (line) => {
    const source = `<!-- sukuna-decisions:v2 -->\n${line}\n`;
    expect(parseDecisionFile(source)).toEqual([]);
    expect(replaceDecisionItems(source, [items[0]])).toBe(
      `${source}${serializeDecision(items[0])}\n`,
    );
  });
  it.each([
    "- [決定] D0: 無効",
    "- [決定] D1: ",
    "- [決定] D1: 本文 <!-- seq=bad -->",
    "- [決定] D2: 本文 → D0",
  ])("形の合わない行 %s を書き換えない", (line) => {
    expect(parseDecisionFile(line)).toEqual([]);
    expect(replaceDecisionItems(line, [])).toBe(`<!-- sukuna-decisions:v2 -->\n${line}`);
  });
});

describe("ファイルの契約の境界", () => {
  const item: DecisionItem = {
    id: "D1",
    kind: "decision",
    text: "本文",
    reason: null,
    seq: null,
    changedTo: null,
  };
  it.each([
    ["41", "42"],
    ["9007199254740991", "9007199254740992"],
    ["9007199254740992", "9007199254740993"],
    ["9007199254740993", "9007199254740994"],
    ["999999999999999999999", "1000000000000000000000"],
    ["1" + "0".repeat(309), "1" + "0".repeat(308) + "1"],
  ])("D%s の次は精度を失わず D%s にする", (id, next) => {
    expect(nextDecisionId(`- [決定] D${id}: 本文`)).toBe(`D${next}`);
  });
  it.each([false, true])("旧形式/新版 %s で本文・理由と根拠の契約を守る", (quoted) => {
    for (const [value, valid] of [
      [{ ...item, text: "🙂".repeat(200) }, true],
      [{ ...item, reason: "🙂".repeat(200) }, true],
      [{ ...item, seq: Number.MAX_SAFE_INTEGER }, true],
      [{ ...item, reason: "" }, true],
      [{ ...item, text: "🙂".repeat(201) }, false],
      [{ ...item, reason: "🙂".repeat(201) }, false],
      [{ ...item, seq: Number.MAX_SAFE_INTEGER + 1 }, false],
    ] as const) {
      const line = quoted
        ? serializeDecision(value)
        : `- [決定] ${value.id}: ${value.text}${value.reason === null ? "" : ` — ${value.reason}`}${value.seq === null ? "" : ` <!-- seq=${value.seq} -->`}`;
      const source = `${quoted ? "<!-- sukuna-decisions:v2 -->\n" : ""}${line}\n`;
      expect(parseDecisionFile(source)).toEqual(valid ? [value] : []);
      if (!valid) {
        const saved = replaceDecisionItems(source, [item]);
        expect(parseDecisionFile(saved)).toEqual([item]);
        expect(saved.split("\n").filter((candidate) => candidate === line)).toEqual([line]);
      }
    }
    const source = `${quoted ? '<!-- sukuna-decisions:v2 -->\n- [決定] D1: "本文"' : "- [決定] D1: 本文"} <!-- seq=${"9".repeat(400)} -->\n`;
    expect(parseDecisionFile(source)).toEqual([]);
  });
  it.each([
    '- [決定] D9: "手書き → D8 を含む文"',
    '- [決定] D9: "手書き <!-- seq=8 --> を含む文"',
    '- [棄却] D9: "本文" — "理由 → D8 を含む文"',
    '- [棄却] D9: "本文" — "理由 <!-- seq=8 --> を含む文"',
    "普通の手書き文",
  ])("旧形式の未管理行 %s は繰り返し保存しても管理へ昇格させない", (handwritten) => {
    const source = `- [決定] D1: 本文\n${handwritten}\n`;
    const initial = parseDecisionFile(source);
    expect(initial).toEqual([item]);
    let saved = source;
    for (const items of [initial, [{ ...item, text: "編集" }], [], initial]) {
      saved = replaceDecisionItems(saved, items);
      expect(parseDecisionFile(saved)).toEqual(items);
      expect(saved.split("\n").filter((line) => line === handwritten)).toEqual([handwritten]);
    }
  });
});

describe("未管理行の由来の保持", () => {
  const item: DecisionItem = {
    id: "D1",
    kind: "decision",
    text: "本文",
    reason: null,
    seq: null,
    changedTo: null,
  };
  const handwritten = '- [決定] D9: "手書き → D8 を含む文"';
  it("由来メタデータと同じ形の手書きだけがあるファイルでも原文を残す", () => {
    const lines = [
      '<!-- sukuna-decisions:unmanaged:v1 [ { "token": "u1", "text": "手書き" } ] -->',
      "<!-- sukuna-decisions:unmanaged:u1:begin -->",
      "手書き",
      "<!-- sukuna-decisions:unmanaged:u1:end -->",
    ];
    let saved = lines.join("\n") + "\n";
    for (const items of [[item], [], [item]]) {
      saved = replaceDecisionItems(saved, items);
      expect(parseDecisionFile(saved)).toEqual(items);
      for (const line of lines)
        expect(saved.split("\n").filter((candidate) => candidate === line)).toEqual([line]);
    }
  });
  it("保護した文を外部で編集してブロックを移しても、その文を未管理のまま残す", () => {
    const initial = replaceDecisionItems(`- [決定] D1: 本文\n${handwritten}\n`, [item]);
    const edited = initial.replace(handwritten, handwritten.replace("手書き", "外部で編集"));
    const lines = edited.split("\n");
    const start = lines.findIndex((line) =>
      /^<!-- sukuna-decisions:unmanaged:u\d+:begin -->$/.test(line),
    );
    const block = lines.splice(start, 3);
    lines.push("前に挿入した文", ...block);
    const moved = lines.join("\n");
    expect(parseDecisionFile(moved)).toEqual([item]);
    const saved = replaceDecisionItems(moved, []);
    expect(parseDecisionFile(saved)).toEqual([]);
    expect(
      saved.split("\n").filter((line) => line === handwritten.replace("手書き", "外部で編集")),
    ).toEqual([handwritten.replace("手書き", "外部で編集")]);
  });
  it("手書き行だけを別の場所へ並べ替えても内容から未管理扱いを保持する", () => {
    const initial = replaceDecisionItems(`- [決定] D1: 本文\n${handwritten}\n`, [item]);
    const lines = initial.split("\n");
    lines.splice(lines.indexOf(handwritten), 1);
    lines.push("挿入した文", handwritten);
    const moved = lines.join("\n");
    expect(parseDecisionFile(moved)).toEqual([item]);
    const saved = replaceDecisionItems(moved, []);
    expect(parseDecisionFile(saved)).toEqual([]);
    expect(saved.split("\n").filter((line) => line === handwritten)).toEqual([handwritten]);
  });
  it("同じ内容の管理行があっても未管理行の個数を保ち、マーカー風の手書き文も残す", () => {
    const same = parseDecisionFile(`<!-- sukuna-decisions:v2 -->\n${handwritten}`)[0];
    const manualMetadata =
      '<!-- sukuna-decisions:unmanaged:v1 [{"token":"u1","text":"手書き"}] -->';
    const manualStart = "<!-- sukuna-decisions:unmanaged:u1:begin -->";
    const manualEnd = "<!-- sukuna-decisions:unmanaged:u1:end -->";
    const source = `${manualMetadata}\n${manualStart}\n手書き\n${manualEnd}\n- [決定] D1: 本文\n${handwritten}\n`;
    let saved = replaceDecisionItems(source, [item, same]);
    for (const items of [[same, item], [], [same]]) {
      saved = replaceDecisionItems(saved, items);
      expect(parseDecisionFile(saved)).toEqual(items);
      expect(saved.split("\n").filter((line) => line === handwritten)).toHaveLength(
        items.some((item) => item.id === same.id) ? 2 : 1,
      );
      for (const line of [manualMetadata, manualStart, manualEnd])
        expect(saved.split("\n").filter((candidate) => candidate === line)).toEqual([line]);
    }
  });
});
