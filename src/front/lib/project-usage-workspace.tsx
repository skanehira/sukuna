import type { ScreenContent } from "../App";
import type { BufferController } from "../buffer/controller";
import { GithubImportPage, githubImportAction, githubImportTitle } from "../pages/github-import";
import { UsagePage, usageTitle } from "../pages/usage";
import type { Route } from "./routes";
import type { createProjectUsageApi } from "./project-usage-api";

type Api = ReturnType<typeof createProjectUsageApi>;
const clock = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const date = new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit" });

export function registerUsageCommand(controller: BufferController): () => void {
  const unregister = controller.commands.register({
    name: "usage",
    label: usageTitle,
    run: () => controller.navigate("/usage"),
  });
  const undeclare = controller.actions.declareHelp([githubImportAction]);
  return () => {
    undeclare();
    unregister();
  };
}

export function loadProjectUsageScreen(
  route: Route,
  controller: BufferController,
  api: Api,
  formatObserved: (at: number) => string,
): Promise<ScreenContent> | undefined {
  if (route.kind === "usage")
    return api.usage().then<ScreenContent, ScreenContent>(
      (usage) => ({
        kind: "ready",
        title: usageTitle,
        fullWindow: true,
        content: (
          <UsagePage
            usage={usage}
            formatObserved={formatObserved}
            formatClock={(at) => clock.format(at)}
          />
        ),
      }),
      (error: unknown) => ({
        kind: "error",
        error: {
          code: "network_error",
          message: error instanceof Error ? error.message : "利用量を読み込めませんでした。",
        },
      }),
    );
  if (route.kind === "project" && route.view === "github-import" && route.id)
    return Promise.resolve({
      kind: "ready",
      title: githubImportTitle,
      fullWindow: true,
      content: (
        <GithubImportPage
          key={route.id}
          controller={controller}
          projectId={route.id}
          api={api}
          formatDate={(at) => date.format(at)}
        />
      ),
    });
}
