import { createConversationProgressHandler } from "./modules/conversation/adapter/progress-routes";
import { createIssueProgressHandler } from "./modules/flow/adapter/progress-routes";
import type { ProgressDependencies } from "./modules/conversation/domain/progress-port";
import type { MessageDependencies } from "./modules/conversation/domain/message-port";
import { createMessageHandler } from "./modules/conversation/adapter/message-routes";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { HealthResponse } from "../shared/api";
import { createIdentityMiddleware, type IdentityEnv } from "./modules/identity/adapter/middleware";
import { createMeHandler } from "./modules/identity/adapter/routes";
import { createTailscaleLocalApi } from "./modules/identity/adapter/tailscale-local-api";
import type { ClockPort, TailscaleLocalApiPort } from "./modules/identity/domain/ports";
import { createResolveIdentity } from "./modules/identity/usecase/resolve-identity";
import { createWorkspaceRoutes } from "./modules/workspace/adapter/http";
import type { WorkspaceDependencies } from "./modules/workspace/domain/ports";

import { createStockRoutes } from "./modules/stock/adapter/http";
import type { StockDependencies } from "./modules/stock/domain/ports";

import { createIssueRoutes } from "./modules/issue/adapter/issue-routes";
import type { IssueServerDeps } from "../shared/issue/ports";

export type IdentityOptions = {
  login: string | undefined;
  devIdentity: string | undefined;
  tailscale: TailscaleLocalApiPort;
  clock: ClockPort;
};

export type AppOptions = {
  clientDir?: string;
  build: string;
  identity?: IdentityOptions;
  workspace?: WorkspaceDependencies;
  progress?: ProgressDependencies;
  messages?: MessageDependencies;
  stock?: StockDependencies;

  issues?: IssueServerDeps;
};

export function createApp(options: AppOptions): Hono<IdentityEnv> {
  const identity = options.identity ?? defaultIdentityOptions();
  const resolveIdentity = createResolveIdentity(identity);
  const app = new Hono<IdentityEnv>();

  app.use("*", createIdentityMiddleware({ resolve: resolveIdentity }));
  if (options.messages)
    app.post("/api/conversations/:id/messages", createMessageHandler(options.messages));

  if (options.progress) {
    app.get("/api/conversations/:id/progress", createConversationProgressHandler(options.progress));
    app.get("/api/issues/:id/progress", createIssueProgressHandler(options.progress));
  }

  app.get("/api/me", createMeHandler(options.build));

  app.get("/api/health", (c) => {
    const body: HealthResponse = { status: "ok" };
    return c.json(body);
  });

  if (options.issues) app.route("/api", createIssueRoutes(options.issues));

  if (options.workspace) app.route("/api/conversations", createWorkspaceRoutes(options.workspace));

  if (options.stock) app.route("/api", createStockRoutes(options.stock));

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

function defaultIdentityOptions(): IdentityOptions {
  return {
    login: process.env.SUKUNA_LOGIN,
    devIdentity: process.env.SUKUNA_DEV_IDENTITY,
    tailscale: createTailscaleLocalApi(),
    clock: { now: () => Date.now() },
  };
}
