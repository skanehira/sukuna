import type { ScreenContent } from "../App";
import type { BufferController } from "../buffer/controller";
import {
  projectSettingsUrl,
  setGlobalFlowPaused,
  showGlobalFlowStatus,
  useProjectSection,
  type ProjectSectionOptions,
} from "../components/settings/project-section";
import { HelpPage } from "../pages/help";
import { resetKeymapAction, SettingsPage } from "../pages/settings";
import { parseRoute, type Route } from "./routes";
import type { SettingsStore } from "./settings-store";

async function openSettings(
  controller: BufferController,
  options: ProjectSectionOptions,
  name: string | undefined,
) {
  const opening = controller.screenOpening();
  const route = parseRoute(controller.options.url ?? "/");
  await options.projects.load();
  if (controller.screenOpening() !== opening) return;
  const { data, error } = options.projects.snapshot();
  if (name && error) throw new Error(error.message);
  const listed = data?.projects ?? [];
  const projectId =
    route.kind === "settings"
      ? new URLSearchParams(route.query).get("project")
      : route.kind === "project"
        ? route.id
        : route.kind === "conversation" && route.id
          ? options.projectForConversation?.(route.id)
          : undefined;
  let matched = name
    ? listed.find((project) => project.name === name)
    : listed.find(
        (project) =>
          project.id === projectId ||
          (route.kind === "conversation" &&
            project.conversations.some((item) => item.id === route.id)) ||
          (route.kind === "issue" && project.issues.some((item) => item.id === route.id)),
      );
  if (name && !matched) throw new Error(`${name} が見つかりません`);
  if (!matched && route.kind === "issue" && route.id) {
    const issueProject = await options.api.issueProject(route.id).catch(() => undefined);
    if (controller.screenOpening() !== opening) return;
    matched = listed.find((project) => project.id === issueProject);
  }
  await controller.navigate(matched ? projectSettingsUrl(matched.id) : "/settings");
}

export function registerSettingsCommands(
  controller: BufferController,
  projects?: ProjectSectionOptions,
  settings?: SettingsStore,
): () => void {
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
      run: (args) => {
        if (args.length > 1) throw new Error("使い方: :set <プロジェクト>");
        return projects
          ? openSettings(controller, projects, args[0])
          : controller.navigate("/settings");
      },
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
  if (projects && settings) {
    remove.push(
      showGlobalFlowStatus(controller, settings),
      ...(
        [
          ["pause", true, "自動フローを一時停止する"],
          ["resume", false, "自動フローを再開する"],
        ] as const
      ).map(([name, paused, label]) =>
        controller.commands.register({
          name,
          label,
          run: () => setGlobalFlowPaused(projects.api, settings, controller, paused),
        }),
      ),
    );
  }
  return () => remove.forEach((unregister) => unregister());
}

function SettingsWithProjectSection({
  controller,
  store,
  formatTime,
  projects,
  selectedProject,
}: {
  controller: BufferController;
  store: SettingsStore;
  formatTime: (at: number) => string;
  projects: ProjectSectionOptions;
  selectedProject: string | null;
}) {
  const section = useProjectSection(projects, controller, store, selectedProject);
  return <SettingsPage store={store} formatTime={formatTime} projectSection={section} />;
}

export function loadSettingsScreen(
  route: Route,
  controller: BufferController,
  store: SettingsStore,
  formatTime: (at: number) => string,
  projects?: ProjectSectionOptions,
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
        content: projects ? (
          <SettingsWithProjectSection
            controller={controller}
            store={store}
            formatTime={formatTime}
            projects={projects}
            selectedProject={new URLSearchParams(route.query).get("project")}
          />
        ) : (
          <SettingsPage store={store} formatTime={formatTime} />
        ),
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
