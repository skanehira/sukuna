import { afterEach, beforeEach } from "vite-plus/test";
import { eq } from "drizzle-orm";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../shared/db/test-helpers";
import { projects, issues, issueEvents, issueDependencies } from "../../../shared/db/schema";
import { readEnvironment } from "../../../shared/env";
import type { AgentScript } from "../../../shared/agent-script";
import type { RunnerNotice } from "../../../shared/ipc";
import { WsHub } from "../../ws-hub";
import type { IssueView } from "../../../shared/issue/schema";
import { startRunnerApp } from "../../../runner/app";
import { ScriptedAgent } from "../../../runner/modules/conversation/adapter/scripted-agent";
import { RunnerLink } from "../../runner-link";
import { createApp } from "../../app";
import { incomingWith, createTailscaleFake } from "../identity/test-support";
import { createIssueDependencies } from "./adapter/dependencies";
import { createLogger } from "../../../shared/log";

export function issueFixture(
  script: AgentScript = { rules: [], fallback: [{ hold: true }] },
  options: Pick<Parameters<typeof startRunnerApp>[0], "issueReports"> = {},
) {
  let home: string;
  let opened: OpenedDatabase;
  let runnerDatabase: OpenedDatabase;
  let runner: Awaited<ReturnType<typeof startRunnerApp>>;
  let link: RunnerLink;
  let app: ReturnType<typeof createApp>;
  let time = 1000000;
  let hub: WsHub;
  const notices: RunnerNotice[] = [];
  const logs: string[] = [];
  const noticeListeners = new Set<() => void>();
  beforeEach(async () => {
    home = createTempHome();
    opened = openMigratedDatabase(home);
    time = 1000000;
    notices.length = 0;
    logs.length = 0;
    noticeListeners.clear();
    hub = new WsHub(opened.sqlite);
    opened.db
      .insert(projects)
      .values({ id: "p", name: "確認", path: home, defaultBranch: "main" })
      .run();
    runnerDatabase = openMigratedDatabase(home);
    runner = await startRunnerApp({
      ...options,
      database: runnerDatabase,
      environment: readEnvironment(
        "runner",
        { SUKUNA_HOME: home },
        home,
        () => true,
      )._unsafeUnwrap(),
      agent: new ScriptedAgent(script),
      clock: { now: () => time, setTimeout: () => () => {} },
      log: () => {},
    });
    await new Promise<void>((resolve) => {
      link = new RunnerLink({
        socket: `${home}/runner.sock`,
        log: () => {},
        notice: (notice) => {
          notices.push(notice);
          hub.notice(notice);
          for (const listener of noticeListeners) listener();
        },
        connection: (connected) => {
          if (connected) resolve();
        },
      });
      link.start();
    });
    app = createApp({
      build: "test",
      identity: {
        login: "dev@example.com",
        devIdentity: "1",
        tailscale: createTailscaleFake().api,
        clock: { now: () => time },
      },
      issues: createIssueDependencies(
        () => opened.db,
        () => link,
        createLogger({ now: () => time, write: (line) => logs.push(line), level: "info" }),
        { now: () => time, id: () => `id-${++seq}` },
        (issueId, projectId) =>
          hub.notice({ kind: "issue", issue_id: issueId, project_id: projectId, seq: 0 }),
      ),
    });
  });
  let seq = 0;
  afterEach(async () => {
    link?.stop();
    await runner?.shutdown();
    runnerDatabase?.close();
    opened?.close();
    if (home) removeTempHome(home);
  });
  return {
    notices,
    logs,
    get hub() {
      return hub;
    },
    async waitNotice(predicate: () => boolean) {
      if (predicate()) return;
      await new Promise<void>((resolve) => {
        const listen = () => {
          if (predicate()) {
            noticeListeners.delete(listen);
            resolve();
          }
        };
        noticeListeners.add(listen);
      });
    },
    get db() {
      return opened.db;
    },
    get opened() {
      return opened;
    },
    get runner() {
      return runner;
    },
    get home() {
      return home;
    },
    get link() {
      return link;
    },
    setTime(value: number) {
      time = value;
    },
    request(path: string, method = "GET", body?: unknown) {
      return app.request(
        path,
        {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        },
        incomingWith("127.0.0.1", 5000),
      );
    },
    addIssue(id: string, number: number, values: Partial<typeof issues.$inferInsert> = {}) {
      opened.db
        .insert(issues)
        .values({
          id,
          projectId: "p",
          number,
          title: id,
          state: "triage",
          createdAt: time,
          updatedAt: time,
          ...values,
        })
        .run();
    },
    depend(issueId: string, dependsOnId: string) {
      opened.db.insert(issueDependencies).values({ issueId, dependsOnId }).run();
    },
    events(id: string) {
      return opened.db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, id))
        .orderBy(issueEvents.seq)
        .all();
    },
    async until(predicate: () => boolean) {
      if (predicate()) return;
      await new Promise<void>((resolve) => {
        const off = runner.runtime.subscribe(() => {
          if (predicate()) {
            off();
            resolve();
          }
        });
      });
    },
  };
}
export function expectedIssue(values: Partial<IssueView>): IssueView {
  return {
    id: "i",
    projectId: "p",
    number: 1,
    title: "i",
    body: "",
    kind: null,
    state: "triage",
    stopReason: null,
    stopDetail: null,
    priority: null,
    designed: false,
    confirmBeforeMerge: false,
    prUrl: null,
    githubNumber: null,
    createdConversationId: null,
    createdConversation: null,
    parent: null,
    children: [],
    dependsOn: [],
    dependents: [],
    conversations: [],
    comments: [],
    createdAt: 1000000,
    updatedAt: 1000000,
    closedAt: null,
    ...values,
  };
}
