import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { replayTimeline } from "./replay";

test.prop([
  fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
  fc.integer({ min: 1, max: 100000 }),
])("逆順の記録から木と題名と新しい順の報告を復元する", (titles, start) => {
  const timeline = replayTimeline({
    version: 1,
    journal: titles
      .map((title, index) => ({
        at: start + index,
        toolUseId: String(index),
        ops: [{ op: "add" as const, id: `task${index}`, title }],
      }))
      .toReversed(),
    reports: titles.map((text, index) => ({ at: start + index, text })),
  });
  expect({
    tasks: timeline.tasks.map(({ id, title, status, completed }) => ({
      id,
      title,
      status,
      completed,
    })),
    defaultTreeId: timeline.defaultTreeId,
    reports: timeline.reports,
    history: timeline.history.map(({ at, taskId, from, to }) => ({ at, taskId, from, to })),
  }).toEqual({
    tasks: titles.map((title, index) => ({
      id: `task${index}`,
      title,
      status: "pending",
      completed: 0,
    })),
    defaultTreeId: `task${titles.length - 1}`,
    reports: titles.map((text, index) => ({ at: start + index, text })).toReversed(),
    history: titles
      .map((_title, index) => ({
        at: start + index,
        taskId: `task${index}`,
        from: null,
        to: "pending",
      }))
      .toReversed(),
  });
});

test.prop([fc.integer({ min: 1, max: 25 }), fc.integer({ min: 1, max: 100 })])(
  "末端の完了を深い木の全祖先と履歴へ伝える",
  (depth, total) => {
    const timeline = replayTimeline({
      version: 1,
      reports: [],
      journal: [
        {
          at: 1,
          toolUseId: "plan",
          ops: Array.from({ length: depth + 1 }, (_, index) => ({
            op: "add" as const,
            id: `task${index}`,
            ...(index ? { parent: `task${index - 1}` } : {}),
          })),
        },
        {
          at: 2,
          toolUseId: "complete",
          ops: [{ op: "update", id: `task${depth}`, done: [total, total] }],
        },
      ],
    });
    expect({
      tasks: timeline.tasks.map(({ id, status, completed }) => ({ id, status, completed })),
      changed: timeline.history
        .filter((entry) => entry.at === 2)
        .map(({ taskId, from, to, completedBefore, completedAfter }) => ({
          taskId,
          from,
          to,
          completedBefore,
          completedAfter,
        })),
    }).toEqual({
      tasks: Array.from({ length: depth + 1 }, (_, index) => ({
        id: `task${index}`,
        status: "completed",
        completed: 1,
      })),
      changed: [
        ...Array.from({ length: depth }, (_, index) => `task${depth - index - 1}`),
        `task${depth}`,
      ].map((taskId) => ({
        taskId,
        from: "pending",
        to: "completed",
        completedBefore: 0,
        completedAfter: 1,
      })),
    });
  },
);
