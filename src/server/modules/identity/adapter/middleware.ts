import type { HttpBindings } from "@hono/node-server";
import type { Context, MiddlewareHandler } from "hono";
import type { IncomingMessage } from "node:http";
import { DENIED_TITLE, deniedMessage, type DeniedReason } from "../../../../shared/denied";
import type { Identity, IdentityDecision } from "../domain/identity";
import type { ResolveIdentity } from "../usecase/resolve-identity";

export type IdentityEnv = {
  Bindings: HttpBindings;
  Variables: { identity: Identity };
};

export type ConnectionSource = {
  address: string;
  port: number;
};

export function createIdentityMiddleware(deps: {
  resolve: ResolveIdentity;
}): MiddlewareHandler<IdentityEnv> {
  return async (c, next) => {
    const source = connectionSourceOf(c);
    if (source === undefined) {
      return deny(c, "identity");
    }
    const decision = await deps.resolve(source);
    if (decision.allowed) {
      c.set("identity", decision.identity);
      await next();
      return;
    }
    return deny(c, decision.reason);
  };
}

export function createUpgradeAuthorizer(deps: { resolve: ResolveIdentity }) {
  return async (request: IncomingMessage): Promise<IdentityDecision> => {
    const { remoteAddress, remotePort } = request.socket;
    if (remoteAddress === undefined || remotePort === undefined) {
      return { allowed: false, reason: "identity" };
    }
    return deps.resolve({ address: remoteAddress, port: remotePort });
  };
}

export function renderDeniedHtml(reason: DeniedReason): string {
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${DENIED_TITLE}</title>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${DENIED_TITLE}</h1>`,
    `<p>${deniedMessage(reason)}</p>`,
    '<a href="">再読み込み</a>',
    "</main>",
    "</body>",
    "</html>",
  ].join("");
}

function connectionSourceOf(c: Context<IdentityEnv>): ConnectionSource | undefined {
  const incoming: IncomingMessage | undefined = c.env?.incoming;
  const { remoteAddress, remotePort } = incoming?.socket ?? {};
  if (remoteAddress === undefined || remotePort === undefined) {
    return undefined;
  }
  return { address: remoteAddress, port: remotePort };
}

function deny(c: Context<IdentityEnv>, reason: DeniedReason): Response {
  const message = deniedMessage(reason);
  if (isApiPath(c.req.path)) {
    return c.json({ error: { code: "unauthorized", message, details: { reason } } }, 401);
  }
  return c.html(renderDeniedHtml(reason), 401);
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}
