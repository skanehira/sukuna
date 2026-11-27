import { Hono } from "hono";
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
  return app;
}
