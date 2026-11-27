import { describe, expect, it } from "vite-plus/test";
import type { LineInfo } from "./line";
import {
  appendLines,
  contentLines,
  contentText,
  createContent,
  replaceAllLines,
  replaceLines,
  setTailLines,
  type BufferContent,
  type ChangeSpec,
} from "./tail";

function text(value: string): LineInfo {
  return { kind: "text", text: value };
}

function applySpecs(doc: string, specs: ChangeSpec[]): string {
  let result = doc;
  const sorted = [...specs].sort((a, b) => b.from - a.from);
  for (const spec of sorted) {
    result = result.slice(0, spec.from) + spec.insert + result.slice(spec.to);
  }
  return result;
}

const content = (): BufferContent => createContent([text("はじめに"), text("本文")]);

describe("contentText と contentLines", () => {
  it("確定した行のあとに、区画の行を決まった順で並べる", () => {
    let value = content();
    value = setTailLines(value, "queue", [text("届く前の指示")]).content;
    value = setTailLines(value, "reply", [text("書きかけ")]).content;
    value = setTailLines(value, "question", [text("質問")]).content;

    expect(contentText(value)).toBe("はじめに\n本文\n書きかけ\n質問\n届く前の指示");
    expect(contentLines(value).map((line) => line.text)).toEqual([
      "はじめに",
      "本文",
      "書きかけ",
      "質問",
      "届く前の指示",
    ]);
  });

  it("空の区画は行を取らない", () => {
    expect(contentText(content())).toBe("はじめに\n本文");
  });
});

describe("appendLines", () => {
  it("追記した行は区画の手前に入り、区画は最後に残る", () => {
    const before = setTailLines(content(), "queue", [text("届く前の指示")]).content;
    const { content: after, specs } = appendLines(before, [text("新しい発言")], []);

    expect(contentText(after)).toBe("はじめに\n本文\n新しい発言\n届く前の指示");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });

  it("追記と区画を空にすることを 1 つの変更で行う", () => {
    const before = setTailLines(content(), "reply", [text("書きかけ")]).content;
    const { content: after, specs } = appendLines(before, [text("保存した発言")], ["reply"]);

    expect(contentText(after)).toBe("はじめに\n本文\n保存した発言");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });

  it("区画の後ろに残る区画は、消した区画のあとに続く", () => {
    const withReply = setTailLines(content(), "reply", [text("書きかけ")]).content;
    const before = setTailLines(withReply, "queue", [text("届く前の指示")]).content;
    const { content: after, specs } = appendLines(before, [text("保存した発言")], ["reply"]);

    expect(contentText(after)).toBe("はじめに\n本文\n保存した発言\n届く前の指示");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });

  it("区画が無いバッファでは、追記した行を末尾に足す", () => {
    const before = content();
    const { content: after, specs } = appendLines(before, [text("追記")], []);

    expect(contentText(after)).toBe("はじめに\n本文\n追記");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });

  it("空のバッファへの追記は、先頭の行になる", () => {
    const before = createContent([]);
    const { content: after, specs } = appendLines(before, [text("最初の行")], []);

    expect(contentText(after)).toBe("最初の行");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });
});

describe("setTailLines", () => {
  it("区画を丸ごと置き換える", () => {
    const before = setTailLines(content(), "reply", [text("書きかけ")]).content;
    const { content: after, specs } = setTailLines(before, "reply", [text("書きかけの続き")]);

    expect(contentText(after)).toBe("はじめに\n本文\n書きかけの続き");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });

  it("空の配列を渡すと区画を消す", () => {
    const before = setTailLines(content(), "reply", [text("書きかけ")]).content;
    const { content: after, specs } = setTailLines(before, "reply", []);

    expect(contentText(after)).toBe("はじめに\n本文");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });

  it("後ろの区画があるときは、前の区画だけを置き換える", () => {
    const withReply = setTailLines(content(), "reply", [text("書きかけ")]).content;
    const before = setTailLines(withReply, "queue", [text("届く前の指示")]).content;
    const { content: after, specs } = setTailLines(before, "reply", []);

    expect(contentText(after)).toBe("はじめに\n本文\n届く前の指示");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });

  it("空の区画に後から行を入れる", () => {
    const before = content();
    const { content: after, specs } = setTailLines(before, "question", [text("質問")]);

    expect(contentText(after)).toBe("はじめに\n本文\n質問");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });
});

describe("replaceLines", () => {
  it("途中の行を置き換えても、区画は残る", () => {
    const before = setTailLines(content(), "queue", [text("届く前の指示")]).content;
    const { content: after, specs } = replaceLines(before, 1, 2, [text("直した本文")]);

    expect(contentText(after)).toBe("はじめに\n直した本文\n届く前の指示");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });

  it("確定した行の末尾を置き換えても、区画の行は消えない", () => {
    const before = setTailLines(content(), "queue", [text("届く前の指示")]).content;
    const { content: after, specs } = replaceLines(before, 2, 2, [text("足した行")]);

    expect(contentText(after)).toBe("はじめに\n本文\n足した行\n届く前の指示");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });
});

describe("replaceAllLines", () => {
  it("確定した行をすべて入れ替えても、区画は残る", () => {
    const before = setTailLines(content(), "queue", [text("届く前の指示")]).content;
    const { content: after, specs } = replaceAllLines(before, [text("並べ替えた行")]);

    expect(contentText(after)).toBe("並べ替えた行\n届く前の指示");
    expect(applySpecs(contentText(before), specs)).toBe(contentText(after));
  });
});
