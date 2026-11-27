import { describe, expect, it } from "vite-plus/test";
import type { LineInfo } from "./line";
import { canPlaceCursor, initialLine, placeCursor } from "./no-cursor";

function line(kind: LineInfo["kind"], text: string, extra: Partial<LineInfo> = {}): LineInfo {
  return { kind, text, ...extra };
}

const text = (value: string) => line("text", value);
const speaker = (value: string) => line("speaker", value);
const separator = () => line("separator", "ここから未読");

describe("canPlaceCursor", () => {
  it("発言者の札・区切り・列の見出しにはカーソルを置けない", () => {
    expect(canPlaceCursor(speaker("あなた"))).toBe(false);
    expect(canPlaceCursor(separator())).toBe(false);
    expect(canPlaceCursor(line("colhead", "番号  題名"))).toBe(false);
  });

  it("開く先の無い見出しには置けず、開く先のある見出しには置ける", () => {
    expect(canPlaceCursor(line("heading", "目次"))).toBe(false);
    expect(canPlaceCursor(line("heading", "目次", { target: { url: "/conversations/1" } }))).toBe(
      true,
    );
    expect(canPlaceCursor(line("section", "未読 3"))).toBe(false);
    expect(canPlaceCursor(line("section", "未読 3", { target: { url: "/" } }))).toBe(true);
  });

  it("文字が空白だけの行には置けず、読み込み中の行には置ける", () => {
    expect(canPlaceCursor(text("   "))).toBe(false);
    expect(canPlaceCursor(text(""))).toBe(false);
    expect(canPlaceCursor(line("skeleton", ""))).toBe(true);
  });

  it("本文と一覧の行には置ける", () => {
    expect(canPlaceCursor(text("こんにちは"))).toBe(true);
    expect(canPlaceCursor(line("row", "01H  題名"))).toBe(true);
  });
});

describe("placeCursor", () => {
  const lines = [
    text("見出しの前"),
    speaker("あなた"),
    text("発言の本文"),
    separator(),
    text("区切りのあと"),
    line("colhead", "番号  題名"),
    text("一覧のあと"),
  ];

  it("下へ動かして置けない行に乗ると、同じ向きの次の置ける行へ移る", () => {
    expect(placeCursor(lines, 0, 1)).toBe(2);
    expect(placeCursor(lines, 2, 3)).toBe(4);
    expect(placeCursor(lines, 4, 5)).toBe(6);
  });

  it("上へ動かして置けない行に乗ると、同じ向きの前の置ける行へ移る", () => {
    expect(placeCursor(lines, 2, 1)).toBe(0);
    expect(placeCursor(lines, 4, 3)).toBe(2);
    expect(placeCursor(lines, 6, 5)).toBe(4);
  });

  it("進めた先がバッファの端を越えたら、乗った行から逆の向きに置ける行を探す", () => {
    expect(placeCursor(lines, 6, 7)).toBe(6);
    expect(placeCursor([speaker("あなた"), text("本文")], 1, 0)).toBe(1);
  });

  it("置ける行が 1 行も無いバッファでは、カーソルを動かさない", () => {
    const empty = [speaker("あなた"), separator(), line("colhead", "番号")];
    expect(placeCursor(empty, 0, 1)).toBe(0);
    expect(placeCursor(empty, 2, 1)).toBe(0);
  });

  it("置ける行に乗ったときは、その行のままにする", () => {
    expect(placeCursor(lines, 1, 2)).toBe(2);
    expect(placeCursor(lines, 3, 4)).toBe(4);
  });
});

describe("initialLine", () => {
  const lines = [line("heading", "目次"), speaker("あなた"), text("本文"), text("   ")];

  it("指定が無ければ、最初の置ける行に置く", () => {
    expect(initialLine(lines, undefined)).toBe(2);
  });

  it("指定の行が置けない行なら、下へ探し、無ければ上へ探す", () => {
    expect(initialLine(lines, 0)).toBe(2);
    expect(initialLine([text("本文"), text("   "), speaker("あなた")], 2)).toBe(0);
  });

  it("置ける行が 1 行も無いバッファでは 1 行目に置く", () => {
    expect(initialLine([line("heading", "目次")], undefined)).toBe(0);
    expect(initialLine([line("heading", "目次"), speaker("AI")], 1)).toBe(0);
  });
});
