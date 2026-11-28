import { z } from "zod";
import type { IssueInput, IssueView } from "../../../shared/issue/schema";
import { issueFields, type IssueField } from "./issue-form-lines";

export type IssueTabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type DraftSnapshot = { id: string | null; issue: IssueView | null };
const editSchema = z.strictObject({ text: z.string(), version: z.string() });
type IssueEdit = z.infer<typeof editSchema>;

export const issueEditKey = (positionKey: string, field: IssueField, id?: string | null) =>
  `sukuna:issue-edit:${id ? `issue:${id}` : `new:${positionKey}`}:${field}`;
const editVersionKey = (key: string) => `sukuna:issue-edit-version:${key}`;

export function readIssueEdit(storage: IssueTabStorage, key: string): IssueEdit | null {
  const recorded = storage.getItem(editVersionKey(key));
  if (recorded !== null) {
    try {
      const parsed = editSchema.safeParse(JSON.parse(recorded));
      if (parsed.success) return parsed.data;
    } catch {}
  }
  const original = storage.getItem(key);
  return original === null ? null : { text: original, version: `legacy:${original}` };
}

export function writeIssueEdit(storage: IssueTabStorage, key: string, edit: IssueEdit): void {
  storage.setItem(editVersionKey(key), JSON.stringify(edit));
  storage.removeItem(key);
}

export function clearIssueEdit(storage: IssueTabStorage, key: string): void {
  storage.removeItem(editVersionKey(key));
  storage.removeItem(key);
}

export function createIssueDraft(
  storage: IssueTabStorage,
  projectId: string,
  positionKey: string,
  create: (input: IssueInput) => Promise<IssueView>,
) {
  const key = `sukuna:issue-created:${projectId}:${positionKey}`;
  const listeners = new Set<() => void>();
  let saved: DraftSnapshot = { id: storage.getItem(key), issue: null };
  let pending: Promise<IssueView> | undefined;

  return {
    snapshot: () => saved,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pending: () => pending,
    begin(input: IssueInput): Promise<IssueView> {
      if (pending) return pending;
      pending = Promise.resolve()
        .then(() => create(input))
        .then((issue) => {
          for (const field of Object.keys(issueFields) as IssueField[]) {
            const previous = issueEditKey(positionKey, field);
            const next = issueEditKey(positionKey, field, issue.id);
            const edit = readIssueEdit(storage, previous);
            if (edit && readIssueEdit(storage, next) === null) writeIssueEdit(storage, next, edit);
            clearIssueEdit(storage, previous);
          }
          storage.setItem(key, issue.id);
          saved = { id: issue.id, issue };
          listeners.forEach((listener) => listener());
          return issue;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}

export type IssueDraft = ReturnType<typeof createIssueDraft>;
