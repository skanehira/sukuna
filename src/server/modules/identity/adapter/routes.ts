import type { Handler } from "hono";
import type { MeResponse } from "../../../../shared/api";
import type { IdentityEnv } from "./middleware";

export function createMeHandler(build: string): Handler<IdentityEnv> {
  return (c) => {
    const identity = c.get("identity");
    const body: MeResponse = {
      login: identity.login,
      device: identity.device,
      build,
    };
    return c.json(body);
  };
}
