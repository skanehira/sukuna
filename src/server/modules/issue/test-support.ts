import type { TerminalCleanupRequest } from "../../../shared/ipc";
import { afterEach, beforeEach } from "vite-plus/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createTempHome,
  openMigratedDatabase,
  removeTempHome,
  type OpenedDatabase,
} from "../../../shared/db/test-helpers";
import { projects, issues, issueEvents, issueDependencies } from "../../../shared/db/schema";
import { readEnvironment } from "../../../shared/env";
import type { GhScript } from "../../../shared/gh-script";
import type { AgentScript } from "../../../shared/agent-script";
import type { RunnerNotice } from "../../../shared/ipc";
import { WsHub } from "../../ws-hub";
import type { IssueView } from "../../../shared/issue/schema";
import { createGitCli } from "../../../runner/modules/workspace/adapter/git-cli";
import { startRunnerApp } from "../../../runner/app";
import { ScriptedAgent } from "../../../runner/modules/conversation/adapter/scripted-agent";
import { RunnerLink } from "../../runner-link";
import { createApp } from "../../app";
import { supplyDesignPrFields } from "../flow/design-test-support";
import { incomingWith } from "../identity/test-support";
import { createIssueDependencies } from "./adapter/dependencies";
import { createLogger } from "../../../shared/log";

export function issueFixture(
  script: AgentScript = { rules: [], fallback: [{ hold: true }] },
  options: Pick<Parameters<typeof startRunnerApp>[0], "issueReports"> & {
    autoFlow?: boolean;
    autoStages?: (typeof projects.$inferInsert)["autoStages"];
    terminalCleanup?: (request: TerminalCleanupRequest) => (() => Promise<void>) | undefined;
    ghScript?: GhScript;
    ghRepository?: string;
  } = {},
) {
  let home: string;
  let opened: OpenedDatabase;
  let runnerDatabase: OpenedDatabase;
  let runner: Awaited<ReturnType<typeof startRunnerApp>>;
  let agent: ScriptedAgent;
  const timers = new Map<() => unknown, number>();
  let link: RunnerLink;
  let app: ReturnType<typeof createApp>;
  let time = 1000000;
  let hub: WsHub;
  const notices: RunnerNotice[] = [];
  const logs: string[] = [];
  const noticeListeners = new Set<() => void>();
  const git = createGitCli();
  let beforeGit: ((args: string[]) => void | Promise<void>) | undefined;
  let afterGit: ((args: string[]) => void | Promise<void>) | undefined;
  const start = async () => {
    runnerDatabase = openMigratedDatabase(home);
    agent = new ScriptedAgent(script);
    runner = await startRunnerApp({
      ...options,
      database: runnerDatabase,
      environment: readEnvironment(
        "runner",
        { SUKUNA_HOME: home, ...(options.ghScript ? { SUKUNA_GH: join(home, "gh.json") } : {}) },
        home,
        () => true,
      )._unsafeUnwrap(),
      agent,
      designGit: {
        run: async (args, options) => {
          await beforeGit?.(args);
          const result = await git.run(args, options);
          await afterGit?.(args);
          return result;
        },
      },
      clock: {
        now: () => time,
        setTimeout: (callback, delay) => {
          timers.set(callback, time + delay);
          return () => {
            timers.delete(callback);
          };
        },
      },
      log: () => {},
    });
    if (options.ghRepository)
      supplyDesignPrFields(
        runner.gh,
        options.ghRepository,
        () =>
          opened.db
            .select()
            .from(issueEvents)
            .orderBy(issueEvents.seq)
            .all()
            .findLast(({ type }) => type === "design_submitted")?.payload,
      );
  };
  beforeEach(async () => {
    home = createTempHome();
    opened = openMigratedDatabase(home);
    if (options.ghScript) writeFileSync(join(home, "gh.json"), JSON.stringify(options.ghScript));
    time = 1000000;
    timers.clear();
    beforeGit = undefined;
    afterGit = undefined;
    notices.length = 0;
    logs.length = 0;
    noticeListeners.clear();
    hub = new WsHub(opened.sqlite);
    opened.db
      .insert(projects)
      .values({
        id: "p",
        name: "確認",
        path: home,
        defaultBranch: "main",
        flowPaused: !options.autoFlow,
        autoStages: options.autoStages,
      })
      .run();
    await start();
    await new Promise<void>((resolve) => {
      link = new RunnerLink({
        socket: `${home}/runner.sock`,
        log: () => {},
        terminalCleanup: options.terminalCleanup,
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
    interceptGitBefore(callback: typeof beforeGit) {
      beforeGit = callback;
    },
    interceptGit(callback: typeof afterGit) {
      afterGit = callback;
    },
    get agent() {
      return agent;
    },
    async restart() {
      await runner.shutdown();
      runnerDatabase.close();
      await start();
    },
    async advanceTo(value: number) {
      time = value;
      const scheduled = Array.from(timers.entries());
      for (const [callback, due] of scheduled) {
        if (due > time) continue;
        timers.delete(callback);
        await callback();
      }
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
