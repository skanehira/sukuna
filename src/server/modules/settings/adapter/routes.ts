import { Hono } from "hono";
import { z } from "zod";
import { restoreBackupIdSchema, restoreIdSchema } from "../../../../shared/settings/restore-schema";
import { keymapInputSchema } from "../../../../shared/settings/keymap-schema";
import type { SettingsDependencies } from "../domain/ports";
import { getSettings } from "../usecase/get-settings";
import { saveKeymap } from "../usecase/save-keymap";
import { keymapRevision } from "./keymap-revision";

export function createSettingsRoutes(deps: SettingsDependencies) {
  const app = new Hono();
  app.get("/settings", async (c) => {
    try {
      const settings = await getSettings(deps);
      return c.json(settings, 200, {
        "Cache-Control": "no-store",
        "X-Keymap-Revision": keymapRevision(settings.keymap),
      });
    } catch {
      return c.json(
        {
          error: { code: "internal", message: "設定を読み込めませんでした。読み直してください。" },
        },
        500,
      );
    }
  });
  app.put("/settings/keymap", async (c) => {
    const parsed = keymapInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: "invalid_input", message: "キーの割り当ての形が正しくありません。" } },
        400,
      );
    try {
      const saved = saveKeymap(parsed.data.entries, deps, c.req.header("If-Match"));
      return saved === null
        ? c.json(
            { error: { code: "keymap_changed", message: "キーの割り当てが変更されました。" } },
            412,
          )
        : c.json(saved);
    } catch {
      return c.json(
        { error: { code: "internal", message: "キーの割り当てを保存できませんでした。" } },
        500,
      );
    }
  });
  app.post("/backup/restore", async (c) => {
    const input = z
      .strictObject({ backupId: restoreBackupIdSchema })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json(
        { error: { code: "invalid_input", message: "復元するバックアップを選び直してください。" } },
        400,
      );
    if (!deps.requestRestore)
      return c.json(
        {
          error: {
            code: "conflict",
            message: "復元の処理が登録されていません。導入のコマンドを実行し直してください。",
          },
        },
        409,
      );
    try {
      const result = await deps.requestRestore(input.data.backupId);
      if (result.isOk()) return c.json(result.value, 202);
      return c.json({ error: result.error }, result.error.code === "not_found" ? 404 : 409);
    } catch {
      return c.json(
        {
          error: {
            code: "internal",
            message: "復元の処理を起動できませんでした。ログを確かめてください。",
          },
        },
        500,
      );
    }
  });
  app.get("/backup/restore/:requestId", (c) => {
    const id = restoreIdSchema.safeParse(c.req.param("requestId"));
    if (!id.success)
      return c.json(
        { error: { code: "invalid_input", message: "復元の依頼を識別できませんでした。" } },
        400,
      );
    try {
      const result = deps.restoreResult?.(id.data);
      return result
        ? c.json(result, 200, { "Cache-Control": "no-store" })
        : c.json(
            {
              error: {
                code: "not_found",
                message: "この復元の結果を確認できませんでした。設定を読み直してください。",
              },
            },
            404,
            { "Cache-Control": "no-store" },
          );
    } catch {
      return c.json(
        { error: { code: "internal", message: "復元の結果を読み出せませんでした。" } },
        500,
      );
    }
  });
  return app;
}
