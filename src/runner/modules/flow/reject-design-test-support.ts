import { eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stockItems } from "../../../shared/db/schema";
import { designFixture } from "../../../server/modules/flow/design-test-support";
import { ScriptedAgent } from "../conversation/adapter/scripted-agent";

const quote = { kind: "terminal", mode: "line", text: "ログの内容" };
const signal = "report-design-ready";

export function rejectionFixture() {
  const fixture = designFixture();
  return Object.assign(fixture, {
    stock(id: string, kind: "instruction" | "question") {
      fixture.db
        .insert(stockItems)
        .values({
          id,
          conversationId: "design",
          kind,
          state: "stocked",
          text: "在庫を確かめる",
          quote: JSON.stringify(quote),
        })
        .run();
    },
    item(id: string) {
      return fixture.db.select().from(stockItems).where(eq(stockItems.id, id)).get();
    },
    messages(this: void) {
      return fixture.runner.runtime.store
        .events("design")
        .filter((event) => event.type === "user_message");
    },
    reportAfterSignal() {
      fixture.runner.runtime.options.agent = new ScriptedAgent({
        rules: [],
        fallback: [
          {
            shell: `for i in $(seq 1 200); do [ ! -f ${signal} ] || exit 0; sleep 0.02; done; exit 1`,
          },
          {
            tool: "mcp__sukuna__report_design",
            input: { number: 42, policy: "在庫を再確認する", checks: [] },
          },
          { end: "success" },
        ],
      });
    },
    report() {
      const path = fixture.runner.runtime.store.get("design")!.cwd;
      writeFileSync(join(path, signal), "");
    },
  });
}
