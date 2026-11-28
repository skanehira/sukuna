import type { Handler } from "hono";
import type { MeResponse } from "../../../../shared/api";
import {
  restoreGenerationHeader,
  restoreRequestHeader,
  type RestoreGeneration,
} from "../../../../shared/settings/restore-schema";

export function createMeHandler(build: string, restoreGeneration?: RestoreGeneration): Handler {
  return (c) => {
    const body: MeResponse = {
      login: "",
      device: "",
      build,
    };
    c.header("Cache-Control", "no-store");
    if (restoreGeneration) c.header(restoreGenerationHeader, restoreGeneration.id);
    if (restoreGeneration?.requestId) c.header(restoreRequestHeader, restoreGeneration.requestId);
    return c.json(body);
  };
}
