import type { ScreenContent } from "../App";
import type { BufferController } from "../buffer/controller";
import { HelpPage } from "../pages/help";
import { resetKeymapAction, SettingsPage } from "../pages/settings";
import type { Route } from "./routes";
import type { SettingsStore } from "./settings-store";

export function registerSettingsCommands(controller: BufferController): () => void {
  const remove = [
    controller.commands.register({
      name: "h",
      label: "ヘルプ",
      run: () => controller.navigate("/help"),
    }),
    controller.commands.register({
      name: "help",
      label: "ヘルプ",
      run: () => controller.navigate("/help"),
    }),
    controller.commands.register({
      name: "set",
      label: "設定",
      run: () => controller.navigate("/settings"),
    }),
    controller.actions.register({
      name: resetKeymapAction,
      label: "キーの割り当てを既定に戻す",
      group: "そのほか",
      where: "設定",
      views: ["settings"],
      confirm: "キーの割り当てを既定に戻しますか?",
      run: () => controller.resetKeymap(),
    }),
  ];
  return () => remove.forEach((unregister) => unregister());
}

export function loadSettingsScreen(
  route: Route,
  controller: BufferController,
  store: SettingsStore,
  formatTime: (at: number) => string,
): Promise<ScreenContent> | undefined {
  if (route.kind === "help")
    return Promise.resolve({
      kind: "ready",
      title: "ヘルプ",
      fullWindow: true,
      content: <HelpPage controller={controller} />,
    });
  if (route.kind === "settings") {
    return store.refresh().then(
      () => ({
        kind: "ready",
        title: "設定",
        fullWindow: true,
        content: <SettingsPage store={store} formatTime={formatTime} />,
      }),
      (error: unknown) => ({
        kind: "error",
        error: {
          code: "network_error",
          message: error instanceof Error ? error.message : "設定を読み込めませんでした。",
        },
      }),
    );
  }
}
