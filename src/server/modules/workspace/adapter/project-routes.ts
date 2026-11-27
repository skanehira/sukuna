import { Hono, type Context } from "hono";
import { err, type Result } from "neverthrow";
import type { ZodError } from "zod";
import { projectPatchSchema, projectRegistrationSchema } from "../../../../shared/api/project";
import type { ProjectDependencies, ProjectError } from "../domain/project-settings";
import { getProject } from "../usecase/get-project";
import { registerProject } from "../usecase/register-project";
import { unregisterProject } from "../usecase/unregister-project";
import { updateProject } from "../usecase/update-project";

const status = {
  invalid_input: 400,
  not_a_repository: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
  runner_unavailable: 503,
} as const;
const fieldReasons = new Map<string, string>([
  ["path", "登録するパスは文字列で指定してください。"],
  ["name", "プロジェクト名は文字列で指定してください。"],
  ["model", "モデルは opus、sonnet、haiku、または未指定を表す null から選んでください。"],
  [
    "permissionMode",
    "許可の扱いは bypassPermissions、acceptEdits、default のいずれかを指定してください。",
  ],
  [
    "autoStages",
    "自動で処理する段階は triage、design、impl から重複せずに選び、配列で指定してください。",
  ],
  ["implConcurrency", "実装の同時実行は 1〜20 件の整数で指定してください。"],
  ["designMergeMode", "設計書の反映のしかたは direct か pr を指定してください。"],
  ["confirmBeforeMergeDefault", "マージ前の確認は true か false を指定してください。"],
  ["flowPaused", "自動フローの一時停止は true か false を指定してください。"],
  ["usesGithub", "GitHub を使うかどうかは true か false を指定してください。"],
  ["defaultBranch", "既定ブランチは空でない文字列で指定してください。"],
]);

function invalidInput(error: ZodError): ProjectError {
  const issue = error.issues[0];
  const field = issue?.path[0];
  const reason = typeof field === "string" ? fieldReasons.get(field) : undefined;
  return {
    code: "invalid_input",
    message:
      reason ??
      (issue?.code === "unrecognized_keys"
        ? "API で指定できる項目だけを送ってください。"
        : "要求の本文は JSON オブジェクトで指定してください。"),
  };
}
const respond = <T extends object>(
  c: Context,
  result: Result<T, ProjectError>,
  success: 200 | 201 = 200,
) =>
  result.isOk()
    ? c.json(result.value, success)
    : c.json({ error: result.error }, status[result.error.code]);
export function createProjectRoutes(deps: ProjectDependencies) {
  const app = new Hono();
  app.onError((_error, c) =>
    c.json(
      {
        error: {
          code: "internal",
          message: "プロジェクトの操作に失敗しました。もう一度操作してください。",
        },
      },
      500,
    ),
  );
  app.post("/projects", async (c) => {
    const parsed = projectRegistrationSchema.safeParse(await c.req.json().catch(() => undefined));
    const result = parsed.success
      ? await registerProject(parsed.data, deps)
      : err(invalidInput(parsed.error));
    return respond(c, result, result.isOk() && !result.value.restored ? 201 : 200);
  });
  app.get("/projects/:id", (c) => respond(c, getProject(c.req.param("id"), deps)));
  app.patch("/projects/:id", async (c) => {
    const parsed = projectPatchSchema.safeParse(await c.req.json().catch(() => undefined));
    return respond(
      c,
      parsed.success
        ? await updateProject(c.req.param("id"), parsed.data, deps)
        : err(invalidInput(parsed.error)),
    );
  });
  app.delete("/projects/:id", async (c) =>
    respond(c, await unregisterProject(c.req.param("id"), deps)),
  );
  return app;
}
