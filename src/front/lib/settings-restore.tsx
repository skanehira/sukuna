import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  restoreAcceptedSchema,
  restoreLookupSchema,
  type RestoreLookup,
} from "../../shared/settings/restore-schema";
import type { BackupItem } from "../../shared/settings/settings-schema";
import type { BufferController } from "../buffer/controller";
import { Frame } from "../buffer/Frame";
import type { LineInfo } from "../buffer/line";
import type { RightView } from "../buffer/right-window";
import { SettingsBuffer } from "../components/settings/SettingsBuffer";
import type { SettingsStore } from "./settings-store";

export const restoreAction = "settings.restore";
export const restorePendingNotice = "復元しています。再起動のあと自動でつながります。";
const selectAction = "settings.restore-select";

function linesFor(items: BackupItem[], formatTime: (at: number) => string): LineInfo[] {
  if (items.length === 0) return [{ kind: "text", text: "復元できるバックアップはありません。" }];
  return [...items]
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .map((item) => ({
      id: item.id,
      kind: "menu",
      action: selectAction,
      text: `${formatTime(item.createdAt)}  ${(item.sizeBytes / 1_000_000).toFixed(1)} MB${item.kind === "before_restore" ? " (復元の直前)" : ""}`,
    }));
}

function RestoreList({
  store,
  formatTime,
}: {
  store: SettingsStore;
  formatTime: (at: number) => string;
}) {
  const settings = useSyncExternalStore(store.subscribe, store.snapshot);
  const lines = useMemo(
    () => linesFor(settings?.backup.items ?? [], formatTime),
    [settings, formatTime],
  );
  return (
    <Frame title="バックアップから復元する" side="right">
      <SettingsBuffer side="right" view="backups" columns={[]} lines={lines} />
    </Frame>
  );
}

const apiError = z.object({ error: z.object({ message: z.string() }) });
export async function postRestore(fetcher: typeof fetch, backupId: string): Promise<string> {
  const response = await fetcher("/api/backup/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backupId }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(apiError.safeParse(body).data?.error.message ?? "復元を依頼できませんでした。");
  }
  return restoreAcceptedSchema.parse(body).requestId;
}

export async function getRestoreResult(
  fetcher: typeof fetch,
  id: string,
): Promise<RestoreLookup | null> {
  const response = await fetcher(`/api/backup/restore/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("復元の結果を読み出せませんでした。");
  return restoreLookupSchema.parse(await response.json());
}

export function createRestoreWorkspace({
  controller,
  store,
  formatTime,
  post,
  getResult,
  schedule,
  finish,
}: {
  controller: BufferController;
  store: SettingsStore;
  formatTime: (at: number) => string;
  post: (backupId: string) => Promise<string>;
  getResult: (id: string) => Promise<RestoreLookup | null>;
  schedule: (callback: () => void, ms: number) => () => void;
  finish: (message: string, kind: "info" | "error") => void;
}) {
  let pending: { item: BackupItem; id: string } | null = null;
  let cancel: (() => void) | undefined;
  let active = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const restarting = {
    snapshot: () => pending !== null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const poll = async () => {
    const request = pending;
    if (request === null) return;
    let result: RestoreLookup | null;
    try {
      result = await getResult(request.id);
    } catch {
      if (pending === request) cancel = schedule(() => void poll(), 1_000);
      return;
    }
    if (pending !== request) return;
    if (result?.status === "pending") {
      cancel = schedule(() => void poll(), 1_000);
      return;
    }
    pending = null;
    emit();
    if (!result || result.requestId !== request.id) {
      finish("この復元の結果を確認できませんでした。設定を読み直してください。", "error");
      return;
    }
    finish(
      result.status === "done"
        ? `${formatTime(request.item.createdAt)} のバックアップから戻しました。自動フローを一時停止しています。:resume で再開します。`
        : (result.message ?? "復元に失敗しました。"),
      result.status === "done" ? "info" : "error",
    );
  };
  return {
    restarting,
    right(view: RightView) {
      return view.view === "backups" ? <RestoreList store={store} formatTime={formatTime} /> : null;
    },
    start() {
      active = true;
      const dispose = [
        controller.actions.register({
          name: restoreAction,
          label: "バックアップから復元する",
          group: "そのほか",
          where: "設定",
          views: ["settings"],
          run: () => controller.openRight({ view: "backups", target: "settings" }),
        }),
        controller.actions.register({
          name: selectAction,
          label: "復元するバックアップを選ぶ",
          group: "そのほか",
          where: "設定",
          views: ["backups"],
          run: async (context) => {
            if (pending !== null) return;
            const id = controller.currentLine("right")?.id;
            if (!id) return;
            const revision = controller.right.openingRevision();
            const current = await store.refresh();
            if (
              controller.right.openingRevision() !== revision ||
              controller.currentLine("right")?.id !== id
            )
              return;
            const item = current.backup.items.find((entry) => entry.id === id);
            if (!item) throw new Error("バックアップが見つかりません。選び直してください。");
            controller.confirm(
              `${formatTime(item.createdAt)} の内容に戻します。動いている AI ${current.runningAiCount} 件を止めます。`,
              context,
              async () => {
                const requestId = await post(id);
                if (!active) return;
                pending = { item, id: requestId };
                controller.closeRight();
                controller.notify(restorePendingNotice);
                emit();
                void poll();
              },
            );
          },
        }),
      ];
      return () => {
        active = false;
        pending = null;
        cancel?.();
        dispose.forEach((unregister) => unregister());
      };
    },
  };
}
