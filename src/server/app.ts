import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { HealthResponse } from "../shared/api";
import { createIdentityMiddleware, type IdentityEnv } from "./modules/identity/adapter/middleware";
import { createMeHandler } from "./modules/identity/adapter/routes";
import { createTailscaleLocalApi } from "./modules/identity/adapter/tailscale-local-api";
import type { ClockPort, TailscaleLocalApiPort } from "./modules/identity/domain/ports";
import { createResolveIdentity } from "./modules/identity/usecase/resolve-identity";

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
};

export function createApp(options: AppOptions): Hono<IdentityEnv> {
  const identity = options.identity ?? defaultIdentityOptions();
  const resolveIdentity = createResolveIdentity(identity);
  const app = new Hono<IdentityEnv>();

  app.use("*", createIdentityMiddleware({ resolve: resolveIdentity }));

  app.get("/api/me", createMeHandler(options.build));

  app.get("/api/health", (c) => {
    const body: HealthResponse = { status: "ok" };
    return c.json(body);
  });

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
