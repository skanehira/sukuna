import {
  createGithubImportRoutes,
  type createGithubImportDependencies,
} from "./modules/issue/adapter/github-import-routes";
import { createUsageRoutes } from "./modules/conversation/adapter/usage-routes";
import type { UsageDependencies } from "./modules/conversation/usecase/get-usage";
import { createProjectRoutes } from "./modules/workspace/adapter/project-routes";
import type { ProjectDependencies } from "./modules/workspace/domain/project-settings";
import { createDesignRoutes } from "./modules/flow/adapter/design-routes";
import type { DesignDependencies } from "./modules/flow/domain/design-ports";
import { createLifecycleRoutes } from "./modules/conversation/adapter/lifecycle-http";
import type { LifecycleDependencies } from "./modules/conversation/domain/lifecycle";
import { createInboxRoutes } from "./modules/inbox/adapter/routes";
import type { InboxDependencies } from "./modules/inbox/domain/ports";
import { createConversationWorktrees } from "./modules/conversation/adapter/worktrees";
import { createConversationRoutes } from "./modules/conversation/adapter/http";
import type { ConversationDependencies } from "./modules/conversation/domain/ports";
import { createPrRoutes } from "./modules/flow/adapter/pr-routes";
import type { PrDependencies } from "./modules/flow/domain/pr-ports";
import { createConversationProgressHandler } from "./modules/conversation/adapter/progress-routes";
import { createIssueProgressHandler } from "./modules/flow/adapter/progress-routes";
import type { ProgressDependencies } from "./modules/conversation/domain/progress-port";
import type { MessageDependencies } from "./modules/conversation/domain/message-port";
import { createMessageHandler } from "./modules/conversation/adapter/message-routes";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { allowsRequestAuthority } from "./network-access";
import { isReadOnlyHttpMethod, type HealthResponse } from "../shared/api";
import {
  initialRestoreGeneration,
  restoreGenerationCheckHeader,
  restoreGenerationHeader,
  restoreRequestHeader,
  type RestoreGeneration,
} from "../shared/settings/restore-schema";
import { createMeHandler } from "./modules/settings/adapter/server-state";
import { createWorkspaceRoutes } from "./modules/workspace/adapter/http";
import type { WorkspaceDependencies } from "./modules/workspace/domain/ports";

import { createStockRoutes } from "./modules/stock/adapter/http";
import type { StockDependencies } from "./modules/stock/domain/ports";

import { createIssueRoutes } from "./modules/issue/adapter/issue-routes";
import type { IssueServerDeps } from "../shared/issue/ports";
import { createWorktreeRoutes } from "./modules/workspace/adapter/worktree-routes";
import type { WorktreeDependencies } from "./modules/workspace/domain/worktree-ports";
import { createRecapRoutes } from "./modules/recap/adapter/http";
import type { RecapDependencies } from "./modules/recap/domain/ports";
import { createSettingsRoutes } from "./modules/settings/adapter/routes";
import type { SettingsDependencies } from "./modules/settings/domain/ports";

export type AppOptions = {
  projects?: ProjectDependencies;
  githubImport?: ReturnType<typeof createGithubImportDependencies>;
  usage?: UsageDependencies;
  pr?: PrDependencies;
  clientDir?: string;
  hostnames?: ReadonlySet<string>;
  build: string;
  restoreGeneration?: RestoreGeneration;
  settings?: SettingsDependencies;
  workspace?: WorkspaceDependencies;
  progress?: ProgressDependencies;
  messages?: MessageDependencies;
  conversations?: ConversationDependencies;
  lifecycle?: LifecycleDependencies;
  stock?: StockDependencies;

  issues?: IssueServerDeps;
  design?: DesignDependencies;
  inbox?: InboxDependencies;
  worktrees?: WorktreeDependencies;
  recap?: RecapDependencies;
};

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  const { hostnames } = options;
  if (hostnames)
    app.use("*", async (c, next) =>
      allowsRequestAuthority(c.req.header("host"), hostnames)
        ? next()
        : c.json({ error: { code: "forbidden", message: "このホスト名では開けません。" } }, 403),
    );
  const restoreGeneration = options.restoreGeneration;
  const currentGeneration = restoreGeneration?.id ?? initialRestoreGeneration;
  app.use("/api/*", async (c, next) => {
    if (isReadOnlyHttpMethod(c.req.method)) return next();
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== new URL(c.req.url).origin)
      return c.json(
        { error: { code: "unauthorized", message: "アプリを開いた画面から接続してください。" } },
        401,
      );
    const expected = c.req.header(restoreGenerationCheckHeader);
    if (expected === undefined || expected === currentGeneration) return next();
    c.header("Cache-Control", "no-store");
    c.header(restoreGenerationHeader, currentGeneration);
    if (restoreGeneration?.requestId) c.header(restoreRequestHeader, restoreGeneration.requestId);
    return c.json(
      {
        error: {
          code: "conflict",
          message: "データベースが復元されました。画面を開き直してください。",
        },
      },
      409,
    );
  });
  if (options.conversations)
    app.route(
      "/api",
      createConversationRoutes(
        options.conversations,
        options.worktrees && createConversationWorktrees(options.worktrees),
      ),
    );
  if (options.messages)
    app.post("/api/conversations/:id/messages", createMessageHandler(options.messages));

  if (options.progress) {
    app.get("/api/conversations/:id/progress", createConversationProgressHandler(options.progress));
    app.get("/api/issues/:id/progress", createIssueProgressHandler(options.progress));
  }

  app.get("/api/me", createMeHandler(options.build, restoreGeneration));

  app.get("/api/health", (c) => {
    const body: HealthResponse = { status: "ok" };
    return c.json(body);
  });

  if (options.settings) app.route("/api", createSettingsRoutes(options.settings));
  if (options.inbox) app.route("/api", createInboxRoutes(options.inbox));
  if (options.projects) app.route("/api", createProjectRoutes(options.projects));

  if (options.pr) app.route("/api", createPrRoutes(options.pr));
  if (options.design) app.route("/api", createDesignRoutes(options.design));
  if (options.githubImport) app.route("/api", createGithubImportRoutes(options.githubImport));
  if (options.usage) app.route("/api", createUsageRoutes(options.usage));
  if (options.issues) app.route("/api", createIssueRoutes(options.issues));
  if (options.recap) app.route("/api/conversations", createRecapRoutes(options.recap));

  if (options.workspace) app.route("/api/conversations", createWorkspaceRoutes(options.workspace));

  if (options.lifecycle) app.route("/api", createLifecycleRoutes(options.lifecycle));
  if (options.stock) app.route("/api", createStockRoutes(options.stock));
  if (options.worktrees) app.route("/api", createWorktreeRoutes(options.worktrees));

  if (options.clientDir !== undefined) {
    const serveClient = serveStatic({ root: options.clientDir });
    const serveIndex = serveStatic({ root: options.clientDir, path: "index.html" });
    app.use("*", serveClient);
    app.get("*", async (c, next) => {
      const path = c.req.path;
      if (path === "/api" || path.startsWith("/api/")) return next();
      return serveIndex(c, next);
    });
  }

  return app;
}
