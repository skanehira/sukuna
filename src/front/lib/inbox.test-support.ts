import { vi } from "vite-plus/test";
import { InboxStore, type InboxApi } from "./inbox-store";
import type {
  InboxResponse,
  InboxRow,
  OverviewResponse,
  ProjectsResponse,
} from "../../shared/inbox/schema";
export function row(patch: Partial<InboxRow> = {}): InboxRow {
  return {
    key: "conversation:c",
    kind: "conversation",
    id: "c",
    project: { id: "p", name: "shop-api" },
    title: "会話: 予約 API の壁打ち",
    section: "decision",
    reason: "question",
    status: "質問 1 件: 期限は?",
    notice: "期限は?",
    unread: true,
    priority: null,
    lastActivityAt: 60000,
    threadAnswers: 0,
    activity: null,
    issue: null,
    ...patch,
  };
}
export function response(...rows: InboxRow[]): InboxResponse {
  return {
    sections: (["decision", "instruction", "working"] as const).map((name) => ({
      name,
      rows: rows.filter((r) => r.section === name),
    })),
  };
}
export function inboxFixture(data = response(row())) {
  const projects: ProjectsResponse = {
    projects: [
      {
        id: "p",
        name: "shop-api",
        flowPaused: false,
        conversations: [{ id: "c", title: "予約 API の壁打ち" }],
        issues: [],
      },
    ],
  };
  const overview: OverviewResponse = {
    project: projects.projects[0],
    issueSections: [],
    conversations: [],
  };
  const api = {
    inbox: vi.fn(async () => data),
    projects: vi.fn(async () => projects),
    overview: vi.fn(async () => overview),
  } satisfies InboxApi;
  const values = new Map<string, string>();
  const store = new InboxStore(api, {
    now: () => 120000,
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
  });
  return { store, api };
}
