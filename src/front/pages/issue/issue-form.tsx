import { useContext, useRef, useSyncExternalStore } from "react";
// oxlint-disable-next-line no-restricted-imports -- 外部システムとの同期: 画面のキー操作と配信を登録し、離れると解除する
import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { IssueView } from "../../../shared/issue/schema";
import {
  ScreenOpeningContext,
  type BufferController,
  type PromptSpec,
} from "../../buffer/controller";
import { Frame } from "../../buffer/Frame";
import { ListingBuffer } from "../../components/listing-buffer";
import type { LifecycleFeed } from "../../components/lifecycle/use-lifecycle";
import { IssueApiError, type IssueApi } from "./issue-api";
import {
  clearIssueEdit,
  issueEditKey,
  readIssueEdit,
  writeIssueEdit,
  type IssueDraft,
  type IssueTabStorage,
} from "./issue-draft";
import {
  issueFieldInput,
  issueFields,
  issueFieldValue,
  issueFormColumns,
  issueFormLines,
  issueFormTitle,
  mayEditIssueField,
  type IssueField,
} from "./issue-form-lines";

const emptySubscribe = () => () => {};
const emptyDraft = () => null;

export function issueFormUrl(id: string): string {
  return `/issues/${encodeURIComponent(id)}/edit`;
}

export function issueDataKey(api: IssueApi, id: string) {
  return ["issue-detail", api, id] as const;
}

function fieldAt(id: string | undefined): IssueField | undefined {
  const key = id?.split(":")[0];
  return key && Object.hasOwn(issueFields, key) ? (key as IssueField) : undefined;
}

export function IssueForm({
  controller,
  api,
  project,
  initial,
  positionKey,
  storage,
  subscribe,
  refreshListings,
  draft,
  nextVersion,
}: {
  controller: BufferController;
  api: IssueApi;
  project: { id: string; name: string; confirmBeforeMergeDefault: boolean };
  initial: IssueView | null;
  positionKey: string;
  storage: IssueTabStorage;
  subscribe: LifecycleFeed;
  refreshListings: (projectId: string) => void;
  draft?: IssueDraft;
  nextVersion: () => string;
}) {
  const opening = useContext(ScreenOpeningContext) ?? controller.screenOpening();
  const pending = useRef(false);
  const creation = useSyncExternalStore(
    draft?.subscribe ?? emptySubscribe,
    draft?.snapshot ?? emptyDraft,
  );
  const id = creation?.id ?? initial?.id;
  const baseline = initial ?? creation?.issue ?? null;
  const { mutate: updateCache } = useSWRConfig();
  const { data, mutate } = useSWR(
    id ? issueDataKey(api, id) : null,
    id ? () => api.get(id) : null,
    {
      fallbackData: baseline ?? undefined,
      revalidateOnMount: id !== undefined,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );
  const issue = data ?? baseline;
  const confirmDefault = project.confirmBeforeMergeDefault;

  useEffect(() => {
    if (!id) return;
    return subscribe(`issue:${id}`, (message) => {
      if (!message || message.type === "changed") void mutate().catch(() => {});
    });
  }, [id, mutate, subscribe]);

  const targetId = () => draft?.snapshot().id ?? initial?.id;
  const key = (field: IssueField) => issueEditKey(positionKey, field, targetId());
  const current = () => opening === controller.screenOpening();
  useEffect(() => {
    if (!draft || !id || pending.current || opening !== controller.screenOpening()) return;
    const state = controller.snapshot();
    if (!state.prompt && !state.command && !state.confirmation) {
      void controller.replace(issueFormUrl(id), controller.options.entry);
    }
  }, [controller, draft, id, opening]);

  const exclusive = async <T,>(perform: () => Promise<T>): Promise<T | undefined> => {
    if (pending.current || !current()) return undefined;
    pending.current = true;
    try {
      return await perform();
    } finally {
      pending.current = false;
    }
  };

  const fieldPrompt = (field: IssueField): PromptSpec | undefined => {
    if (pending.current || !current() || !mayEditIssueField(issue, field)) return;
    const label = issueFields[field];
    const carried = readIssueEdit(storage, key(field));
    const savedValue = issueFieldValue(field, issue, confirmDefault);
    const openingVersion = carried?.version ?? nextVersion();
    let version = openingVersion;
    return {
      label,
      target: issue ? `#${issue.number}` : project.name,
      verb: "保存する",
      initialText: carried?.text ?? savedValue,
      allowEmpty: true,
      change() {
        version = nextVersion();
      },
      close(text) {
        const fieldKey = key(field);
        if (text === savedValue && version === openingVersion) clearIssueEdit(storage, fieldKey);
        else writeIssueEdit(storage, fieldKey, { text, version });
      },
      async submit(text) {
        return exclusive(async () => {
          const input = issueFieldInput(field, text);
          const promptId = controller.snapshot().promptId;
          const submittedVersion = version;
          const storedVersion = readIssueEdit(storage, key(field))?.version;
          const waiting = draft?.pending();
          const existing = targetId() ?? (waiting ? (await waiting).id : undefined);
          if (!current()) return false;
          const saved = existing ? await api.update(existing, input) : await draft?.begin(input);
          if (!saved) return false;
          if (existing) await updateCache(issueDataKey(api, existing)).catch(() => undefined);
          const fieldKey = key(field);
          const cached = readIssueEdit(storage, fieldKey);
          if (cached && (cached.version === storedVersion || cached.version === submittedVersion))
            clearIssueEdit(storage, fieldKey);
          refreshListings(project.id);
          if (!current()) return false;
          controller.notify(`${label}を書き換えました`);
          if (draft) {
            const active = controller.snapshot();
            const submittedPrompt =
              active.promptId === promptId &&
              controller.promptText() === text &&
              version === submittedVersion;
            if (!active.command && !active.confirmation && (!active.prompt || submittedPrompt)) {
              if (active.prompt) {
                controller.closePrompt(text);
                if (readIssueEdit(storage, fieldKey)?.version === submittedVersion) {
                  clearIssueEdit(storage, fieldKey);
                }
              }
              await controller.replace(issueFormUrl(saved.id), controller.options.entry);
            }
          }
          return version === submittedVersion;
        }).then((result) => result ?? false);
      },
    };
  };

  useEffect(() => {
    const previous = controller.options.prompt?.bind(controller.options);
    const prompt = () => {
      if (controller.snapshot().active !== "main" || controller.context().view !== "issue-form")
        return previous?.();
      const field = fieldAt(controller.currentLine()?.id);
      return field ? fieldPrompt(field) : undefined;
    };
    controller.options.prompt = prompt;
    const actions = [
      controller.actions.register({
        name: "issue.confirm",
        label: "確定する",
        group: "そのほか",
        where: issueFormTitle,
        views: ["issue-form"],
        run: async () => {
          await exclusive(async () => {
            try {
              const waiting = draft?.pending();
              const existing = targetId() ?? (waiting ? (await waiting).id : undefined);
              if (!current()) return;
              if (!existing)
                throw new IssueApiError("title_required", "題名を書いてから確定してください");
              await api.confirm(existing);
              refreshListings(project.id);
              if (!current()) return;
              controller.notify("確定しました。AI が精査を始めます");
              await controller.replace(`/projects/${encodeURIComponent(project.id)}`);
            } catch (error) {
              if (!current()) return;
              if (!(error instanceof IssueApiError && error.code === "title_required")) throw error;
              controller.notify("題名を書いてから確定してください", "error");
              controller.place("main", 1, 0);
            }
          });
        },
      }),
      controller.actions.register({
        name: "issue.save-draft",
        label: "下書きとして保存する",
        group: "そのほか",
        where: issueFormTitle,
        views: ["issue-form"],
        run: async () => {
          if (pending.current || !current()) return;
          controller.notify("下書きを保存しました");
          await controller.run("back");
        },
      }),
    ];
    controller.setHints("issue-form", [
      ["prompt.open", "項目を書く"],
      ["back", "戻る"],
    ]);
    return () => {
      if (controller.options.prompt === prompt) controller.options.prompt = previous;
      actions.forEach((remove) => remove());
      controller.setHints("issue-form", []);
    };
  });

  const lines = issueFormLines(project.name, issue, confirmDefault).map((line) => {
    const field = fieldAt(line.id);
    return field && mayEditIssueField(issue, field)
      ? {
          ...line,
          open: () => {
            const spec = fieldPrompt(field);
            if (spec) controller.openPrompt(spec);
          },
        }
      : line;
  });
  return (
    <Frame title={issueFormTitle} side="main">
      <ListingBuffer
        lines={lines}
        columns={issueFormColumns}
        side="main"
        posKey={positionKey}
        viewName="issue-form"
      />
    </Frame>
  );
}
