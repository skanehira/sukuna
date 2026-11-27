import { createApp } from "../server/app";
import { createLifecycleDependencies } from "../server/modules/conversation/adapter/lifecycle-dependencies";
import {
  createClockFake,
  createTailscaleFake,
  incomingWith,
} from "../server/modules/identity/test-support";
import { createWorkspaceDependencies } from "../server/modules/workspace/adapter/dependencies";
import { createTempHome, openMigratedDatabase, removeTempHome } from "../shared/db/test-helpers";

export function createLifecycleSearchFixture() {
  const home = createTempHome();
  const database = openMigratedDatabase(home);
  const { sqlite } = database;
  sqlite
    .prepare("INSERT INTO projects(id,name,path,default_branch) VALUES ('p1','予約',?,'main')")
    .run(home);
  const insert = sqlite.prepare(
    "INSERT INTO conversations(id,project_id,kind,parent_conversation_id,title,cwd,run_state,closed_at,last_activity_at) VALUES (?,'p1',?,?,?,?,'idle',?,?)",
  );
  insert.run("closed", "chat", null, "在庫の閉じた相談", home, 2000, 2000);
  insert.run("t1", "thread", "closed", "在庫の終えたスレッド", home, 3000, 3000);
  sqlite
    .prepare(
      "INSERT INTO issues(id,project_id,number,title,body,state,created_at,updated_at) VALUES ('i1','p1',1,'引き当ての改善','在庫の引き当てを見直す','draft',1000,1000)",
    )
    .run();
  const app = createApp({
    build: "test",
    identity: {
      login: "test@example.com",
      devIdentity: "1",
      tailscale: createTailscaleFake().api,
      clock: createClockFake(),
    },
    lifecycle: createLifecycleDependencies({
      database: () => database,
      home,
      runner: {
        async forward() {
          throw new Error("検索ではランナーを呼びません");
        },
      },
      workspace: createWorkspaceDependencies(() => database.db),
      gh: {
        async run() {
          throw new Error("検索では gh を呼びません");
        },
      },
      log: () => {},
      now: () => 100_000,
      withdraw: async () => {},
      changed: () => {},
    }),
  });
  return {
    request: (path: string) => app.request(path, {}, incomingWith("127.0.0.1", 1)),
    close() {
      database.close();
      removeTempHome(home);
    },
  };
}
