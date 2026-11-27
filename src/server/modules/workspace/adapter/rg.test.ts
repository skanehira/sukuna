import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vite-plus/test";
import { createRg } from "./rg";

const early = { path: "src/z.ts", line: 2, col: 0, text: "hit before deadline" };
const earlier = { path: "src/a.ts", line: 3, col: 0, text: "hit collected first" };
const late = { path: "src/c.ts", line: 1, col: 0, text: "hit after deadline" };
function rgLine(match: typeof early): string {
  return `${JSON.stringify({ type: "match", data: { path: { text: match.path }, lines: { text: `${match.text}\n` }, line_number: match.line, submatches: [{ start: 0 }] } })}\n`;
}

it.each([
  {
    name: "9999msでは後続の結果も採用する",
    elapsed: 9_999,
    before: [rgLine(early), rgLine(earlier)],
    after: rgLine(late),
    matches: [earlier, late, early],
    timedOut: false,
  },
  {
    name: "10000msでは期限前の結果を残し後着を除く",
    elapsed: 10_000,
    before: [rgLine(early), rgLine(earlier)],
    after: rgLine(late),
    matches: [earlier, early],
    timedOut: true,
  },
  {
    name: "10001msでも期限後の結果を採用しない",
    elapsed: 10_001,
    before: [rgLine(early), rgLine(earlier)],
    after: rgLine(late),
    matches: [earlier, early],
    timedOut: true,
  },
  {
    name: "最初の結果が期限後なら空の結果になる",
    elapsed: 10_000,
    before: [],
    after: rgLine(late),
    matches: [],
    timedOut: true,
  },
  {
    name: "期限前に未完だった行を後着のchunkで完成させない",
    elapsed: 10_000,
    before: [rgLine(early), rgLine(earlier).slice(0, 30)],
    after: rgLine(earlier).slice(30) + rgLine(late),
    matches: [early],
    timedOut: true,
  },
])("rgの検索は $name", async ({ elapsed, before, after, matches, timedOut }) => {
  const lifecycle: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      lifecycle.push("kill");
    },
  });
  let deadline = Infinity;
  let expire = () => {};
  const search = createRg(
    {
      schedule(callback, milliseconds) {
        deadline = milliseconds;
        expire = callback;
        return () => {
          lifecycle.push("cancel");
        };
      },
    },
    {},
    () => child,
  );

  const pending = search.content("/workspace", "hit");
  for (const chunk of before) child.stdout.emit("data", chunk);
  if (elapsed >= deadline) expire();
  child.stdout.emit("data", after);
  child.emit("close", timedOut ? null : 0);
  const result = await pending;

  expect({ result: result._unsafeUnwrap(), lifecycle }).toEqual({
    result: { matches, truncated: false, timedOut },
    lifecycle: timedOut ? ["kill", "cancel"] : ["cancel"],
  });
});
