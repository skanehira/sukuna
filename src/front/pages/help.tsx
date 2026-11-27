import { useMemo, useSyncExternalStore } from "react";
import { Frame } from "../buffer/Frame";
import type { BufferController } from "../buffer/controller";
import { helpLines } from "../buffer/help-lines";
import type { ColumnDef } from "../buffer/line";
import { SettingsBuffer } from "../components/settings/SettingsBuffer";

const columns: ColumnDef[] = [
  { name: "help", widths: [24, 25, 14], heads: ["キー", "動作", "使える場所"] },
];

export function HelpPage({ controller }: { controller: BufferController }) {
  const entries = useSyncExternalStore(controller.subscribe, controller.bindingSnapshot);
  const actions = useSyncExternalStore(controller.actions.subscribe, controller.actions.snapshot);
  const commands = useSyncExternalStore(
    controller.commands.subscribe,
    controller.commands.snapshot,
  );
  const lines = useMemo(
    () => helpLines(entries, actions, commands, "help"),
    [entries, actions, commands],
  );
  return (
    <Frame title="ヘルプ" side="main" columns={columns}>
      <SettingsBuffer view="help" columns={columns} lines={lines} />
    </Frame>
  );
}
