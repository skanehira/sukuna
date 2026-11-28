import { incomingWith } from "../../identity/test-support";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { createApp } from "../../../app";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../../shared/db/test-helpers";
import {
  conversations,
  conversationEvents,
  issues,
  projects,
  settings,
} from "../../../../shared/db/schema";
import { newIssue } from "../../../../shared/issue/rules";
import { createUsageDependencies } from "./usage-routes";

const hour = 60 * 60 * 1000;
const now = 10 * 24 * hour;
let home: string;
let database: OpenedDatabase;
beforeEach(() => {
  home = createTempHome();
  database = openMigratedDatabase(home);
  database.db
    .insert(projects)
    .values([
      { id: "p", name: "在庫", path: home, defaultBranch: "main" },
      { id: "empty", name: "利用なし", path: home + "/empty", defaultBranch: "main" },
      {
        id: "removed",
        name: "解除済み",
        path: home + "/removed",
        defaultBranch: "main",
        removedAt: now,
      },
    ])
    .run();
});
afterEach(() => {
  database.close();
  removeTempHome(home);
});

function seedConversation(
  id: string,
  parent: string | null = null,
  issueId: string | null = null,
  projectId = "p",
) {
  database.db
    .insert(conversations)
    .values({
      id,
      projectId,
      kind: parent ? "thread" : "chat",
      issueId,
      parentConversationId: parent,
      cwd: home,
    })
    .run();
}
function turn(conversationId: string, seq: number, createdAt: number, input: number, cost: number) {
  database.db
    .insert(conversationEvents)
    .values({
      conversationId,
      seq,
      createdAt,
      type: "turn_end",
      payload: {
        subtype: "success",
        usage: {
          input_tokens: input,
          output_tokens: 3,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
        cost_usd: cost,
        duration_ms: 40,
        permission_denials: 0,
      },
    })
    .run();
}
function request() {
  return createApp({
    build: "test",
    usage: createUsageDependencies(
      () => database.db,
      () => now,
    ),
  }).request("/api/usage", undefined, incomingWith("127.0.0.1", 5000));
}

it("期間の境界にある番とスレッドを元のissueに数え、累計料金の差だけを集計する", async () => {
  database.db
    .insert(issues)
    .values({ ...newIssue("i", "p", 7, 1, false), title: "在庫の整理" })
    .run();
  seedConversation("main", null, "i");
  seedConversation("thread", "main");
  seedConversation("nested", "thread");
  seedConversation("ordinary");
  seedConversation("historical", null, null, "removed");
  turn("main", 1, now - 7 * 24 * hour - 1, 101, 4);
  turn("main", 2, now - 7 * 24 * hour, 4, 5);
  turn("main", 3, now - 5 * hour - 1, 8, 7);
  turn("main", 4, now - 5 * hour, 16, 8);
  turn("thread", 1, now - hour, 24, 3);
  turn("nested", 1, now - 2 * hour, 1, 1);
  turn("ordinary", 1, now - 2 * hour, 2, 2);
  turn("historical", 1, now - 2 * hour, 48, 4);
  const response = await request();
  expect({ status: response.status, value: await response.json() }).toEqual({
    status: 200,
    value: {
      now,
      rateLimit: null,
      projects: [
        {
          projectId: "p",
          name: "在庫",
          total: { tokens5h: 67, tokens7d: 91, costUsd7d: 10 },
          issues: [
            {
              issueId: "i",
              number: 7,
              title: "在庫の整理",
              tokens5h: 59,
              tokens7d: 83,
              costUsd7d: 8,
            },
          ],
          withoutIssue: { tokens5h: 8, tokens7d: 8, costUsd7d: 2 },
        },
      ],
    },
  });
});

it("保存された超過利用と観測日時を返す", async () => {
  database.db
    .insert(settings)
    .values({
      key: "usage.rate_limit",
      value: {
        status: "rejected",
        resetsAt: now + hour,
        observedAt: now - 1,
        overageStatus: "allowed",
      },
    })
    .run();
  const response = await request();
  expect({ status: response.status, value: await response.json() }).toEqual({
    status: 200,
    value: {
      now,
      projects: [],
      rateLimit: {
        status: "rejected",
        resetsAt: now + hour,
        observedAt: now - 1,
        usingOverage: true,
      },
    },
  });
});
