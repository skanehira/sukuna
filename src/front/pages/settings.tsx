import { useMemo, useSyncExternalStore } from "react";
import type { Settings } from "../../shared/settings/settings-schema";
import { Frame } from "../buffer/Frame";
import type { ColumnDef, LineInfo } from "../buffer/line";
import { SettingsBuffer } from "../components/settings/SettingsBuffer";
import type { SettingsStore } from "../lib/settings-store";
import { restoreAction } from "../lib/settings-restore";
import type { ProjectSection } from "../components/settings/project-section";
import { Skeleton } from "../shell/loading";
import { WindowError } from "../shell/ShellBoundary";

const columns: ColumnDef[] = [{ name: "settings", widths: [12, 38], heads: ["項目", "値"] }];
const projectColumns: ColumnDef[] = [
  { ...columns[0], widths: [18, 36] },
  { name: "settings-menu", widths: [1.4, 22, 13] },
];
const waiting: LineInfo[] = [{ kind: "skeleton", text: "読み込み中" }];

export const resetKeymapAction = "settings.keymap-reset";

function settingsLines(
  settings: Settings,
  formatTime: (at: number) => string,
  projectSection?: ProjectSection,
): LineInfo[] {
  const { backup, keymap } = settings;
  const days = backup.items.filter((item) => item.kind === "daily").length;
  const detail =
    backup.lastError !== null
      ? `最終: 失敗${backup.lastAt === null ? "" : ` ${formatTime(backup.lastAt)}`} ${backup.lastError}`
      : backup.lastAt === null || backup.items.length === 0
        ? "まだありません"
        : `最終: ${formatTime(backup.lastAt)}、${days} 日分`;
  const pair = (name: string, value: string): LineInfo => ({
    kind: "pair",
    id: name,
    colDef: "settings",
    text: `${name}  ${value}`,
    cols: [name, value],
  });
  return [
    { kind: "heading", text: "全体" },
    ...(projectSection?.globalFlow ? [projectSection.globalFlow[0]] : []),
    pair("バックアップ", `毎日 ${backup.schedule}  (${detail})`),
    ...(projectSection?.globalFlow ? [projectSection.globalFlow[1]] : []),
    pair(
      "キーの割り当て",
      keymap.entries.length === 0
        ? "既定のまま"
        : `既定から ${keymap.entries.length} 件を変更 (:map で変える)`,
    ),
    {
      kind: "menu",
      id: resetKeymapAction,
      action: resetKeymapAction,
      text: "キーの割り当てを既定に戻す",
      cols: ["キーの割り当てを既定に戻す", ""],
    },
    {
      kind: "menu",
      id: restoreAction,
      action: restoreAction,
      text: "バックアップから復元する",
      cols: ["バックアップから復元する", "確認のうえ復元する"],
    },
    ...(projectSection?.projectLines ?? []),
  ];
}

export function SettingsPage({
  store,
  formatTime,
  projectSection,
}: {
  store: SettingsStore;
  formatTime: (at: number) => string;
  projectSection?: ProjectSection;
}) {
  const settings = useSyncExternalStore(store.subscribe, store.snapshot);
  const lines = useMemo(
    () => (settings ? settingsLines(settings, formatTime, projectSection) : waiting),
    [settings, formatTime, projectSection],
  );
  const displayColumns = projectSection ? projectColumns : columns;
  const startLine = projectSection?.startAtProject
    ? lines.findIndex((line) => line.id === "settings.project")
    : undefined;
  return (
    <Frame title="設定" side="main" columns={displayColumns}>
      {projectSection?.missingProject ? (
        <WindowError
          message="プロジェクトが見つかりません。一覧から選び直してください。"
          {...projectSection.missingProject}
        />
      ) : projectSection?.waitingForProject ? (
        <Skeleton side="main" />
      ) : (
        <SettingsBuffer
          view="settings"
          columns={displayColumns}
          lines={lines}
          startLine={startLine}
        />
      )}
    </Frame>
  );
}
