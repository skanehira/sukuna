import type { SettingsDependencies } from "../domain/ports";

export async function setFlowPaused(
  paused: boolean,
  dependencies: Pick<
    SettingsDependencies,
    "putFlowPaused" | "notifyFlow" | "changed" | "inboxChanged"
  >,
): Promise<{ paused: boolean }> {
  dependencies.putFlowPaused(paused);
  dependencies.changed();
  dependencies.inboxChanged();
  await dependencies.notifyFlow();
  return { paused };
}
