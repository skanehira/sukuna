import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { formatLastAction, lastActionInTurn, toolTarget } from "./last-action";

const command = fc
  .array(fc.constantFrom("a", "あ", "🙂", "𠮷"), { minLength: 1, maxLength: 90 })
  .map((letters) => letters.join(""));
test.prop([command, fc.string(), fc.constantFrom("\n", "\r\n")])(
  "Bashの先頭行をUnicodeの60字までで表示する",
  (first, tail, newline) => {
    const text = `Bash(${first})`;
    const letters = Array.from(text);
    expect(formatLastAction("Bash", { command: first + newline + tail }, "/work")).toBe(
      letters.length > 60 ? letters.slice(0, 60).join("") + "…" : text,
    );
  },
);
test.prop([command, fc.integer({ min: 1, max: 100000 })])(
  "再開後の最後のツールを番の時刻とともに返す",
  (text, at) => {
    const letters = Array.from(`Bash(${text})`);
    expect(
      lastActionInTurn(
        [
          {
            seq: 1,
            type: "tool_use",
            payload: { name: "Read", input: { file_path: "old" } },
            createdAt: 1,
          },
          { seq: 2, type: "resumed", payload: {}, createdAt: at },
          {
            seq: 3,
            type: "tool_use",
            payload: { name: "Bash", input: { command: text } },
            createdAt: at + 1,
          },
          { seq: 4, type: "assistant_text", payload: { text: "応答" }, createdAt: at + 2 },
        ],
        "/work",
      ),
    ).toEqual({
      lastAction: letters.length > 60 ? letters.slice(0, 60).join("") + "…" : letters.join(""),
      lastActionAt: at + 1,
      turnStartedAt: at,
    });
  },
);

test.prop([command, fc.constantFrom("Read", "Edit", "Write", "NotebookEdit")])(
  "許可対象のパスは作業ディレクトリからの相対にして文字数で省略しない",
  (path, tool) => {
    const target = `config/${path}/production.env`;
    const field = tool === "NotebookEdit" ? "notebook_path" : "file_path";
    expect(toolTarget(tool, { [field]: `/work/${target}` }, "/work")).toBe(target);
  },
);
