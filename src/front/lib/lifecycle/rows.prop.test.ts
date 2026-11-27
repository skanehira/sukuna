import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { groupsForProjects } from "./rows";

const times = fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), {
  minLength: 2,
  maxLength: 10,
});

test.prop([times, times])(
  "プロジェクト横断で新しい親が先に並び、子は元の親の直下を id 順に並ぶ",
  (parents, threads) => {
    const entries = parents.map((lastActivityAt, index) => ({
      id: "c" + index,
      title: "会話 " + index,
      lastActivityAt,
      runState: "idle" as const,
      closedAt: null,
      threads: threads.map((childAt, childIndex) => ({
        id: String(threads.length - childIndex).padStart(2, "0"),
        lastActivityAt: childAt,
        title: "質問 " + childIndex,
        runState: "idle" as const,
        closedAt: null,
      })),
    }));
    const projects = entries.map((entry) => ({
      project: { id: entry.id, name: entry.title, conversations: [], issues: [] },
      listing: { conversations: [entry], issueThreads: [] },
    }));
    const sorted = groupsForProjects(projects);
    const expected = [...parents]
      .sort((a, b) => b - a)
      .map((time) => ({
        parent: "c" + parents.indexOf(time),
        children: Array.from({ length: threads.length }, (_, i) => String(i + 1).padStart(2, "0")),
      }));
    expect(
      sorted.map((group) => ({
        parent: group.id,
        children: group.threads.map((thread) => thread.id),
      })),
    ).toEqual(expected);
  },
);
