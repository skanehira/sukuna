import { Buffer } from "./buffer/Buffer";
import { Frame } from "./buffer/Frame";
import { Layout } from "./buffer/Layout";
import type { ColumnDef, LineInfo } from "./buffer/line";

const conversation: LineInfo[] = [
  { kind: "heading", text: "会話: バッファの土台", target: { url: "/conversations/1" } },
  { kind: "speaker", text: "あなた" },
  { kind: "text", text: "バッファの行の種類と装飾の持ち方を、設計どおりに作りたい。" },
  { kind: "speaker", text: "AI" },
  { kind: "text", text: "line.ts の LineInfo を正本にして、state.ts に StateField を置きました。" },
  { kind: "tool", text: "vp test --run src/front/buffer" },
  { kind: "code", text: "const bufferField = StateField.define<BufferView>({ ... })" },
  { kind: "add", text: "+ view.dispatch({ changes, effects, annotations })" },
  { kind: "del", text: "- view.setState(next)" },
  { kind: "separator", text: "ここから未読" },
  { kind: "text", text: "発言の帯は、前の最終行から作り直しても途切れないようにします。" },
  {
    kind: "menu",
    text: "1  続きを実装する  実装を始める",
    cols: ["1", "続きを実装する", "実装を始める"],
    action: "continue",
    main: true,
  },
  {
    kind: "menu",
    text: "2  止める  このスレッドだけ止める",
    cols: ["2", "止める", "このスレッドだけ止める"],
    action: "halt",
    danger: true,
  },
  {
    kind: "menu",
    text: "3  送った回答  ✓ 送った回答",
    cols: ["3", "送った回答", "✓ 送った回答"],
    action: "sendanswers",
    done: true,
  },
  { kind: "note", text: "AI は動き続けています。" },
];

const tree: LineInfo[] = [
  { kind: "heading", text: "sukuna", target: { url: "/" } },
  { kind: "tree", text: "▾ issue-19 バッファの土台", tone: "muted" },
  { kind: "tree", text: "  #17 行の種類と装飾" },
  { kind: "tree", text: "  #18 追記と書き換え" },
  { kind: "tree", text: "▸ 会話", tone: "muted" },
];

const recentColumns: ColumnDef[] = [{ name: "recent", widths: [4, 0], heads: ["時刻", "出来事"] }];

const recent: LineInfo[] = [
  {
    kind: "row",
    text: "12:04  バッファの土台を作った",
    cols: ["12:04", "バッファの土台を作った"],
    colDef: "recent",
  },
  {
    kind: "row",
    text: "11:52  追記のまとめ方を決めた",
    cols: ["11:52", "追記のまとめ方を決めた"],
    colDef: "recent",
  },
  {
    kind: "row",
    text: "11:40  issue を読んだ",
    cols: ["11:40", "issue を読んだ"],
    colDef: "recent",
  },
];

export function App() {
  return (
    <Layout
      tree={
        <Frame title="sukuna" side="tree">
          <Buffer side="tree" lines={tree} onReady={() => undefined} />
        </Frame>
      }
      main={
        <Frame title="会話: バッファの土台" side="main" active>
          <Buffer
            side="main"
            lines={conversation}
            onReady={(handle) => {
              handle.setTail("reply", [
                { kind: "text", text: "書きかけの発言を、末尾の区画に出しています…" },
              ]);
              handle.setTail("queue", [{ kind: "queued", text: "届く前の指示: テストを先に書く" }]);
            }}
          />
        </Frame>
      }
      right={
        <Frame title="直近" side="right" columns={recentColumns}>
          <Buffer side="right" lines={recent} columns={recentColumns} onReady={() => undefined} />
        </Frame>
      }
    />
  );
}
