import { describe, expect, it } from "vitest";
import { replayTimeline } from "./replay";

describe("タイムラインの復元", () => {
  it("時刻順に復元し深さ優先のタスクと親の変更履歴、報告を返す", () => {
    expect(
      replayTimeline({
        version: 1,
        journal: [
          {
            at: 20,
            toolUseId: "update",
            agentId: "agent",
            ops: [{ op: "update", id: "child", status: "completed", note: "完了" }],
          },
          {
            at: 10,
            toolUseId: "add",
            ops: [
              { op: "add", id: "root", title: "計画" },
              { op: "add", id: "other" },
              { op: "add", id: "child", parent: "root", done: [1, 2], description: "説明" },
            ],
          },
        ],
        reports: [
          { at: 1, text: "古い報告" },
          { at: 180001, text: "新しい報告" },
        ],
        comments: [
          { at: 20, taskId: "child", text: "後" },
          { at: 10, taskId: "child", text: "前" },
        ],
      }),
    ).toEqual({
      defaultTreeId: "other",
      trees: [
        {
          id: "root",
          title: "計画",
          status: "completed",
          completed: 1,
          parts: { pending: 0, in_progress: 0, completed: 1, blocked: 0 },
          leaves: { total: 1, pending: 0, in_progress: 0, completed: 1, blocked: 0 },
          startedAt: 10,
        },
        {
          id: "other",
          title: "other",
          status: "pending",
          completed: 0,
          parts: { pending: 1, in_progress: 0, completed: 0, blocked: 0 },
          leaves: { total: 1, pending: 1, in_progress: 0, completed: 0, blocked: 0 },
          startedAt: 10,
        },
      ],
      tasks: [
        {
          id: "root",
          parent: null,
          title: "計画",
          status: "completed",
          weight: 1,
          completed: 1,
          units: "1 / 1",
        },
        {
          id: "child",
          parent: "root",
          title: "child",
          status: "completed",
          weight: 1,
          done: [2, 2],
          description: "説明",
          note: "完了",
          completed: 1,
          units: "2 / 2",
        },
        {
          id: "other",
          parent: null,
          title: "other",
          status: "pending",
          weight: 1,
          completed: 0,
          units: "0 / 1",
        },
      ],
      history: [
        {
          at: 20,
          taskId: "root",
          title: "計画",
          from: "in_progress",
          to: "completed",
          weight: 1,
          completedBefore: 0.5,
          completedAfter: 1,
          description: null,
          note: null,
          agentId: "agent",
        },
        {
          at: 20,
          taskId: "child",
          title: "child",
          from: "in_progress",
          to: "completed",
          weight: 1,
          completedBefore: 0.5,
          completedAfter: 1,
          description: null,
          note: "完了",
          agentId: "agent",
        },
        {
          at: 10,
          taskId: "root",
          title: "計画",
          from: "pending",
          to: "in_progress",
          weight: 1,
          completedBefore: 0,
          completedAfter: 0.5,
          description: null,
          note: null,
          agentId: null,
        },
        {
          at: 10,
          taskId: "child",
          title: "child",
          from: null,
          to: "in_progress",
          weight: 1,
          completedBefore: 0,
          completedAfter: 0.5,
          description: "説明",
          note: null,
          agentId: null,
        },
        {
          at: 10,
          taskId: "other",
          title: "other",
          from: null,
          to: "pending",
          weight: 1,
          completedBefore: 0,
          completedAfter: 0,
          description: null,
          note: null,
          agentId: null,
        },
        {
          at: 10,
          taskId: "root",
          title: "計画",
          from: null,
          to: "pending",
          weight: 1,
          completedBefore: 0,
          completedAfter: 0,
          description: null,
          note: null,
          agentId: null,
        },
      ],
      reports: [
        { at: 180001, text: "新しい報告" },
        { at: 1, text: "古い報告" },
      ],
      comments: [
        { at: 10, taskId: "child", text: "前" },
        { at: 20, taskId: "child", text: "後" },
      ],
    });
  });

  it("進行中の木を優先し無ければ最後に追加した木を選ぶ", () => {
    const timeline = replayTimeline({
      version: 1,
      journal: [
        {
          at: 0,
          toolUseId: "1",
          ops: [
            { op: "add", id: "active", status: "in_progress" },
            { op: "add", id: "last" },
          ],
        },
      ],
      reports: [],
    });
    expect({
      selected: timeline.defaultTreeId,
      starts: timeline.trees.map((tree) => tree.startedAt),
    }).toEqual({ selected: "active", starts: [null, null] });
  });

  it("完了と未着手の子が混在する進行中の木も最新の未着手の木より優先する", () => {
    const timeline = replayTimeline({
      version: 1,
      journal: [
        {
          at: 10,
          toolUseId: "plan",
          ops: [
            { op: "add", id: "active" },
            { op: "add", id: "done", parent: "active", status: "completed" },
            { op: "add", id: "pending", parent: "active" },
            { op: "add", id: "last" },
          ],
        },
      ],
      reports: [],
    });
    expect(timeline.defaultTreeId).toBe("active");
  });
});
