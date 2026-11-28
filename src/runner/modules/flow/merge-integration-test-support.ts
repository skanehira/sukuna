import { afterEach, expect } from "vite-plus/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
} from "../../../shared/db/test-helpers";
import { createWorktreeActivity } from "../../../shared/workspace/sqlite-worktree-activity";
import { startRunnerApp } from "../../app";
import { createWorkspaceAgent } from "../../../server/modules/workspace/adapter/worktree-conversation-test-support";
import { createApp } from "../../../server/app";
import { RunnerLink } from "../../../server/runner-link";
import { createIssueDependencies } from "../../../server/modules/issue/adapter/dependencies";
import { createPrDependencies } from "../../../server/modules/flow/adapter/pr-dependencies";
import { incomingWith } from "../../../server/modules/identity/test-support";
import type { AgentPort } from "../conversation/domain/agent-port";
import { testEnvironment } from "../../../test/directories";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const sha = "a".repeat(40);
export const flowText = "merge を許可されました。merge の手順で CI を待って merge してください";
export async function fixture(options: { failSdkOpen?: boolean } = {}) {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const sql = database.sqlite;
  const oldPath = join(home, "old");
  mkdirSync(oldPath);
  sql
    .prepare(
      "INSERT INTO projects(id,name,path,default_branch,uses_github,model,permission_mode) VALUES ('p','project',?,'main',1,'sonnet','acceptEdits')",
    )
    .run(home);
  sql
    .prepare(
      "INSERT INTO issues(id,project_id,number,title,state,stop_reason,pr_url,created_at,updated_at) VALUES ('i','p',1,'issue','stopped','merge_confirm','https://github.com/example/fixture/pull/1',1,1)",
    )
    .run();
  sql
    .prepare(
      "INSERT INTO worktrees(id,project_id,path,branch,origin,issue_id) VALUES ('w','p',?,'impl','flow','i')",
    )
    .run(oldPath);
  sql
    .prepare(
      "INSERT INTO conversations(id,project_id,kind,issue_id,cwd,worktree_id) VALUES ('c','p','impl','i',?,'w')",
    )
    .run(oldPath);
  const observed = createWorkspaceAgent("sdk");
  const finishFlow = deferred();
  let n = 0;
  const agent: AgentPort = {
    ...observed.agent,
    open(params) {
      const index = n++;
      if (index > 0 && options.failSdkOpen) throw new Error("SDK open failed");
      const session = observed.agent.open(params);
      let first = true;
      return {
        ...session,
        output: {
          async *[Symbol.asyncIterator]() {
            for await (const output of session.output) {
              if (index > 0 && first && output.kind === "turn_end") {
                first = false;
                await finishFlow.promise;
              }
              yield output;
            }
          },
        },
      };
    },
  };
  const environment = testEnvironment(home, {
    SUKUNA_AGENT: "fake",
    SUKUNA_AGENT_SCRIPT: join(home, "unused.json"),
  });
  const runner = await startRunnerApp({
    database,
    environment,
    agent,
    log: () => {},
    clock: { now: () => 1000, setTimeout: () => () => {} },
  });
  const connected = deferred();
  const link = new RunnerLink({
    socket: environment.socket,
    log: () => {},
    notice: () => {},
    connection: (up) => {
      if (up) connected.resolve();
    },
  });
  link.start();
  await connected.promise;
  const deps = createPrDependencies({
    database: () => database.db,
    gh: {
      run: async () => ({
        stdout: JSON.stringify({ state: "OPEN", headRefOid: sha }),
        stderr: "",
        exitCode: 0,
      }),
    },
    runner: () => link,
    now: () => 1000,
    changed: () => {},
  });
  const app = createApp({
    build: "test",
    pr: deps,
    issues: createIssueDependencies(
      () => database.db,
      () => link,
      () => {},
      { now: () => 1000, id: () => "unused" },
    ),
  });
  const permit = async () => {
    const response = await app.request(
      "/api/issues/i/pr/allow-merge",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ headSha: sha }),
      },
      incomingWith("127.0.0.1", 1),
    );
    return { status: response.status, body: await response.json() };
  };
  const rawMessages = () =>
    sql
      .prepare(
        "SELECT payload FROM conversation_events WHERE conversation_id='c' AND type='user_message' ORDER BY seq",
      )
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload));
  const queued = {
    id: "q",
    conversationId: "c",
    text: "queued instruction",
    images: [],
    position: 1,
    clientId: "queued-client",
    createdAt: 1000,
    stockItemId: "s",
  };
  await runner.runtime.send("c", { text: "initial", images: [], origin: "developer" });
  await expect.poll(() => runner.runtime.store.get("c")?.runState).toBe("idle");
  sql
    .prepare(
      "INSERT INTO stock_items(id,conversation_id,kind,text,state) VALUES ('s','c','instruction','queued instruction','sent')",
    )
    .run();
  runner.runtime.store.transaction(() => runner.runtime.store.enqueue(queued));
  cleanups.push(async () => {
    finishFlow.resolve();
    link.stop();
    await observed.dispose();
    await runner.shutdown();
    database.close();
    removeTempHome(home);
  });
  return {
    home,
    oldPath,
    database,
    sql,
    runner,
    observed,
    permit,
    async withdraw() {
      const response = await app.request(
        "/api/issues/i/withdraw",
        { method: "POST" },
        incomingWith("127.0.0.1", 1),
      );
      expect(response.status).toBe(200);
    },
    finishFlow,
    queued,
    rawMessages,
    holdOtherFlow() {
      const path = join(home, "other");
      mkdirSync(path);
      sql
        .prepare(
          "INSERT INTO worktrees(id,project_id,path,branch,origin,issue_id) VALUES ('other','p',?,'other','flow','i')",
        )
        .run(path);
      return createWorktreeActivity(database.directories.state).acquire(["other"])._unsafeUnwrap();
    },
    change(mode: string) {
      let cwd = home;
      let id: string | null = null;
      if (mode === "move") {
        cwd = join(home, "moved");
        mkdirSync(cwd);
        id = "w";
        sql.prepare("UPDATE worktrees SET path=? WHERE id='w'").run(cwd);
      } else {
        sql.prepare("UPDATE worktrees SET removed_at=1000 WHERE id='w'").run();
        if (mode === "same-path-new-id") {
          cwd = oldPath;
          id = "replacement";
          sql
            .prepare(
              "INSERT INTO worktrees(id,project_id,path,branch,origin,issue_id) VALUES ('replacement','p',?,'replacement','flow','i')",
            )
            .run(cwd);
        }
      }
      rmSync(oldPath, { recursive: true });
      if (cwd === oldPath) mkdirSync(cwd);
      sql.prepare("UPDATE conversations SET cwd=?,worktree_id=? WHERE id='c'").run(cwd, id);
      return { cwd, id };
    },
    state() {
      return {
        issue: sql.prepare("SELECT state,stop_reason,updated_at FROM issues WHERE id='i'").get(),
        events: sql.prepare("SELECT * FROM issue_events WHERE issue_id='i'").all(),
        messages: rawMessages(),
        queue: runner.runtime.store.queue("c"),
        stock: sql.prepare("SELECT id,state,sent_seq FROM stock_items WHERE id='s'").get(),
      };
    },
  };
}
export const scenarios = ["remove", "move", "same-path-new-id"].flatMap((mode) =>
  ["close", "consume"].map((boundary) => ({ mode, boundary })),
);
export function pauseOld(f: Awaited<ReturnType<typeof fixture>>, boundary: string) {
  const entered = deferred();
  let finish = () => {};
  const pause = (done: () => void) => {
    finish = done;
    entered.resolve();
  };
  if (boundary === "close") f.observed.delayClose(pause);
  else f.observed.delayOutputEnd(pause);
  return { entered: entered.promise, release: () => finish() };
}
