import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { HealthResponse } from "../shared/api";

export type AppOptions = {
  clientDir?: string;
};

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

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
