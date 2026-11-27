import type { Handler } from "hono";
import type { MeResponse } from "../../../../shared/api";
import {
  restoreGenerationHeader,
  restoreRequestHeader,
  type RestoreGeneration,
} from "../../../../shared/settings/restore-schema";
import type { IdentityEnv } from "./middleware";

export function createMeHandler(
  build: string,
  restoreGeneration?: RestoreGeneration,
): Handler<IdentityEnv> {
  return (c) => {
    const identity = c.get("identity");
    const body: MeResponse = {
      login: identity.login,
      device: identity.device,
      build,
    };
    c.header("Cache-Control", "no-store");
    if (restoreGeneration) c.header(restoreGenerationHeader, restoreGeneration.id);
    if (restoreGeneration?.requestId) c.header(restoreRequestHeader, restoreGeneration.requestId);
    return c.json(body);
  };
}
