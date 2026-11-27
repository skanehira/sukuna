import { expect, it } from "vite-plus/test";
import { createLogger } from "./log";
it("ログは許した項目だけを JSON にし、debug 以外のスタックを出さない", () => {
  const lines: string[] = [];
  const log = createLogger({ now: () => 0, write: (line) => lines.push(line), level: "info" });
  log({ level: "debug", component: "runner.agent", message: "hidden" });
  const entry = {
    level: "info" as const,
    component: "runner.agent",
    message: "実行",
    conversation_id: "c",
    text: "secret instruction",
  };
  log(entry);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      time: "1970-01-01T00:00:00.000Z",
      level: "info",
      component: "runner.agent",
      message: "実行",
      conversation_id: "c",
    },
  ]);
});
