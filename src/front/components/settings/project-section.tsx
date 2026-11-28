import { useCallback, useRef, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- バッファの操作と配信の購読を画面の表示期間に登録する
import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { ProjectSettings } from "../../../shared/api/project";
import type { ServerMessage } from "../../../shared/ws";
import type { BufferController, BufferSnapshot } from "../../buffer/controller";
import type { ActionContext } from "../../buffer/keymap/registry";
import type { LineInfo } from "../../buffer/line";
import type { InboxStore } from "../../lib/inbox-store";
import {
  ProjectSettingsRequestError,
  type ProjectSettingsApi,
} from "../../lib/project-settings-api";
import type { SettingsStore } from "../../lib/settings-store";
import { parseProjectSetting, projectFields } from "./project-setting-values";

const flowAction = "settings.flow.toggle";
const projectFlowAction = "settings.project-flow.toggle";
const editAction = "settings.project.edit";
const registerAction = "settings.project.register";
const removeAction = "settings.project.remove";
const importAction = "settings.project.github-import";
const usageAction = "settings.project.usage";
const registerTitle = "プロジェクトを登録する";
const removeTitle = "このプロジェクトの登録を解除する";
const importTitle = "GitHub の issue を下書きとして取り込む";
const usageTitle = "利用量を見る";
const flowStatus = "自動フロー停止中";

export type ProjectSectionOptions = {
  api: ProjectSettingsApi;
  projects: InboxStore["projects"];
  subscribeInbox: (receive: (message?: ServerMessage) => void) => () => void;
  projectForConversation?: (id: string) => string | undefined;
};

export type ProjectSection = {
  globalFlow: [LineInfo, LineInfo] | undefined;
  projectLines: LineInfo[];
  startAtProject: boolean;
  waitingForProject: boolean;
  missingProject?: { onHome: () => void; onReload: () => void };
};

export const projectSettingsUrl = (id: string) => `/settings?project=${encodeURIComponent(id)}`;
const flowLabel = (paused: boolean) =>
  paused ? "自動フローを再開する" : "自動フローを一時停止する";
const changeMessage = (paused: boolean) =>
  paused ? "自動フローを一時停止しました" : "自動フローを再開しました";

function menu(action: string, label: string, detail = "", danger = false): LineInfo {
  return {
    kind: "menu",
    id: action,
    action,
    colDef: "settings-menu",
    text: label,
    cols: [label, detail],
    danger,
  };
}

const forProject = (action: string, id: string) => `${action}:${id}`;

function pair(id: string, label: string, value: string, action?: string): LineInfo {
  return {
    kind: "pair",
    id,
    colDef: "settings",
    text: `${label}  ${value}`,
    cols: [label, value],
    ...(action ? { action, editLabel: label } : {}),
  };
}

function projectLines(project: ProjectSettings): LineInfo[] {
  return [
    { kind: "heading", id: "settings.project", text: `プロジェクト ${project.name}` },
    ...projectFields.map((field) =>
      pair(
        `settings.project.${field.key ?? field.label}`,
        field.label,
        field.value(project),
        field.key === undefined ? undefined : forProject(editAction, project.id),
      ),
    ),
    { kind: "note", text: "値の行で i を押すと、その値を書けます。" },
    menu(
      forProject(projectFlowAction, project.id),
      `このプロジェクトの${flowLabel(project.flowPaused)}`,
      "",
      !project.flowPaused,
    ),
    menu(forProject(importAction, project.id), importTitle),
    menu(usageAction, usageTitle),
    menu(registerAction, registerTitle),
    menu(forProject(removeAction, project.id), removeTitle, "", true),
  ];
}

export async function setGlobalFlowPaused(
  api: ProjectSettingsApi,
  store: SettingsStore,
  controller: BufferController,
  paused: boolean,
) {
  await api.pause(paused);
  controller.notify(changeMessage(paused));
  await store.refresh();
}

export function showGlobalFlowStatus(controller: BufferController, store: SettingsStore) {
  let remove: (() => void) | undefined;
  const update = () => {
    const paused = store.snapshot()?.flowPaused === true;
    if (paused && !remove)
      remove = controller.registerStatusItem("settings.global-flow", flowStatus);
    if (!paused && remove) {
      remove();
      remove = undefined;
    }
  };
  const unsubscribe = store.subscribe(update);
  update();
  return () => {
    unsubscribe();
    remove?.();
  };
}

function selectedProjectId(
  index: ReturnType<InboxStore["projects"]["snapshot"]>,
  requestedId: string | null,
): string | undefined {
  const listed = index.data?.projects;
  if (requestedId === null) return listed?.[0]?.id;
  if (!listed || index.error || listed.some((item) => item.id === requestedId)) return requestedId;
}

const projectKey = (id: string) => ["project-settings", id] as const;

type Removal = {
  isCurrent: () => boolean;
  confirmation: BufferSnapshot["confirmation"];
  cancel?: () => void;
};

function useProjectRemoval(
  controller: BufferController,
  { api, projects }: ProjectSectionOptions,
  selectedId: string | null,
  missing: boolean,
) {
  const pending = useRef<Removal | null>(null);
  useEffect(() => {
    if (missing) return;
    const clear = () => {
      const operation = pending.current;
      pending.current = null;
      operation?.cancel?.();
    };
    const recheck = () => {
      const operation = pending.current;
      if (
        operation &&
        (!operation.isCurrent() || controller.snapshot().confirmation !== operation.confirmation)
      )
        clear();
    };
    const unsubscribeController = controller.subscribe(recheck);
    const unsubscribeProjects = projects.subscribe(recheck);
    return () => {
      unsubscribeController();
      unsubscribeProjects();
      clear();
    };
  }, [controller, missing, projects, selectedId]);

  return useCallback(
    async ({ id, name }: ProjectSettings, context: ActionContext) => {
      const opening = controller.screenOpening();
      const interaction = controller.interactionRevision();
      const { promptId } = controller.snapshot();
      const currentRow = () => {
        const { id, line } = controller.windowPosition(context.window) ?? {};
        return id ?? line;
      };
      const row = currentRow();
      const isCurrent = () => {
        const state = controller.snapshot();
        return (
          controller.screenOpening() === opening &&
          state.active === context.window &&
          state.mode === "NORMAL" &&
          state.promptId === promptId &&
          !state.prompt &&
          state.command === null &&
          row !== undefined &&
          currentRow() === row &&
          selectedProjectId(projects.snapshot(), selectedId) === id
        );
      };
      const isStillWaiting = () => isCurrent() && controller.interactionRevision() === interaction;
      if (missing || !isCurrent() || controller.snapshot().confirmation) return;
      const operation: Removal = { isCurrent: isStillWaiting, confirmation: null };
      pending.current = operation;
      try {
        const { stopTargetCount } = await api.get(id);
        if (pending.current !== operation || !isStillWaiting()) return;
        const count =
          stopTargetCount > 0 ? ` AI を止める会話 ${stopTargetCount} 件があります。` : "";
        pending.current = null;
        const cancel = controller.confirm(
          `プロジェクト「${name}」の登録を解除しますか?${count} リポジトリのファイルは消しません。`,
          context,
          async () => {
            if (!isCurrent()) return;
            await api.remove(id);
            controller.notify("プロジェクトの登録を解除しました");
            await projects.refresh();
          },
        );
        pending.current = { isCurrent, confirmation: controller.snapshot().confirmation, cancel };
      } catch (error) {
        if (pending.current === operation && isStillWaiting()) throw error;
      } finally {
        if (pending.current === operation) pending.current = null;
      }
    },
    [api, controller, missing, projects, selectedId],
  );
}

export function useProjectSection(
  options: ProjectSectionOptions,
  controller: BufferController,
  store: SettingsStore,
  selectedId: string | null,
): ProjectSection {
  const { api, projects, subscribeInbox } = options;
  const settings = useSyncExternalStore(store.subscribe, store.snapshot);
  const index = useSyncExternalStore(projects.subscribe, projects.snapshot);
  const id = selectedProjectId(index, selectedId);
  const { mutate: updateCache } = useSWRConfig();
  const editPrompt = useRef<{ projectId: string; promptId: number } | null>(null);
  const { data, error, mutate } = useSWR(
    id ? projectKey(id) : null,
    ([, projectId]) => api.get(projectId),
    {
      dedupingInterval: 0,
      revalidateOnMount: true,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  );

  const detailMissing = error instanceof ProjectSettingsRequestError && error.status === 404;
  const missing = selectedId !== null && (!id || detailMissing);
  const project = detailMissing || missing ? undefined : data;
  const confirmRemoval = useProjectRemoval(
    controller,
    options,
    selectedId,
    detailMissing || missing,
  );
  useEffect(() => {
    const edit = editPrompt.current;
    if (
      missing &&
      edit?.projectId === selectedId &&
      controller.snapshot().promptId === edit.promptId
    ) {
      editPrompt.current = null;
      controller.closePrompt();
    }
  }, [controller, missing, selectedId]);

  useEffect(() => {
    if (!id) return;
    return subscribeInbox((message) => {
      if (!message || (message.type === "changed" && message.payload.project_ids?.includes(id)))
        void mutate().catch(() => undefined);
    });
  }, [id, mutate, subscribeInbox]);

  useEffect(() => {
    if (!project?.flowPaused || settings?.flowPaused) return;
    return controller.registerStatusItem("settings.project-flow", flowStatus);
  }, [controller, project?.flowPaused, settings?.flowPaused]);

  useEffect(() => {
    if (!settings) return;
    const act = (
      name: string,
      label: string,
      run: Parameters<BufferController["actions"]["register"]>[0]["run"],
    ) =>
      controller.actions.register({
        name,
        label,
        group: "そのほか",
        where: "設定",
        views: ["settings"],
        run,
      });
    const opening = controller.screenOpening();
    const remove = [
      act(flowAction, flowLabel(settings.flowPaused), () =>
        setGlobalFlowPaused(api, store, controller, !settings.flowPaused),
      ),
      act(registerAction, registerTitle, () =>
        controller.openPrompt({
          label: "プロジェクトのパス",
          target: "Git リポジトリ",
          verb: "登録する",
          complete: {
            verb: "パスを補う",
            description: "濃い字は Git のリポジトリ",
            async query(text) {
              const { candidates, truncated, note } = await api.pathCandidates(text);
              return {
                candidates: candidates.map(({ name, text, repository }) => ({
                  text,
                  label: `${name}/`,
                  strong: repository,
                })),
                truncated,
                note,
              };
            },
          },
          async submit(path) {
            const promptId = controller.snapshot().promptId;
            const result = await api.register(path);
            controller.notify(
              result.notes.length ? result.notes.join(" / ") : "プロジェクトを登録しました",
            );
            await projects.refresh();
            const current = controller.snapshot();
            if (
              controller.screenOpening() === opening &&
              current.prompt &&
              current.promptId === promptId &&
              controller.promptText() === path
            )
              await controller.navigate(projectSettingsUrl(result.project.id));
          },
          close() {},
        }),
      ),
    ];
    if (project) {
      const { id, name } = project;
      remove.push(
        act(forProject(editAction, id), "プロジェクトの設定を書く", ({ window }) => {
          const line = controller.currentLine(window);
          const field = projectFields.find(
            ({ key }) => key && line?.id === `settings.project.${key}`,
          );
          const key = field?.key;
          if (!field || !key) return;
          controller.openPrompt({
            label: field.label,
            target: name,
            verb: "保存する",
            initialText: field.value(project),
            allowEmpty: true,
            async submit(text) {
              const patch = parseProjectSetting(key, text);
              if (!patch) throw new Error(`${field.label}に書ける値: ${field.allowed}`);
              if (selectedId !== null && selectedProjectId(projects.snapshot(), selectedId) !== id)
                throw new Error("プロジェクトが見つかりません");
              await updateCache(projectKey(id), () => api.update(id, patch));
              controller.notify(`${field.label}を書き換えました`);
            },
            close() {
              editPrompt.current = null;
            },
          });
          editPrompt.current = { projectId: id, promptId: controller.snapshot().promptId };
        }),
        act(
          forProject(projectFlowAction, id),
          `このプロジェクトの${flowLabel(project.flowPaused)}`,
          async () => {
            const paused = !project.flowPaused;
            await updateCache(projectKey(id), () => api.update(id, { flowPaused: paused }));
            controller.notify(changeMessage(paused));
            await projects.refresh();
          },
        ),
        act(forProject(importAction, id), importTitle, () =>
          controller.navigate(`/projects/${encodeURIComponent(id)}/import`),
        ),
        act(usageAction, usageTitle, () => controller.navigate("/usage")),
        act(forProject(removeAction, id), removeTitle, (context) =>
          confirmRemoval(project, context),
        ),
      );
    }
    return () => remove.forEach((unregister) => unregister());
  }, [
    api,
    confirmRemoval,
    controller,
    project,
    projects,
    selectedId,
    settings,
    store,
    updateCache,
  ]);

  const listingError = index.error?.message;
  const detailError = error instanceof Error ? error.message : undefined;
  const problem = detailError ?? (!index.data ? listingError : undefined);
  const waiting = !problem && !project && (!index.data || id !== undefined);
  return {
    globalFlow: settings
      ? [
          pair("settings.flow", "自動フロー", settings.flowPaused ? "停止中" : "動作中"),
          menu(
            flowAction,
            flowLabel(settings.flowPaused),
            "全プロジェクトに効く",
            !settings.flowPaused,
          ),
        ]
      : undefined,
    projectLines: project
      ? projectLines(project)
      : waiting
        ? [{ kind: "skeleton", text: "プロジェクトを読み込み中" }]
        : [
            { kind: "note", text: problem ?? "プロジェクトはまだありません" },
            menu(registerAction, registerTitle),
          ],
    startAtProject: selectedId !== null && project !== undefined,
    waitingForProject: selectedId !== null && waiting,
    ...(missing
      ? {
          missingProject: {
            onHome: () => void controller.navigate("/"),
            onReload: () => {
              void projects.refresh();
              if (id) void mutate().catch(() => undefined);
            },
          },
        }
      : {}),
  };
}
