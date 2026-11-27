import { act, render, screen } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import type { Event } from "../lib/conversation/types";
import { WorkingLine, liveActivity } from "./working-line";

it("配信のツールを作業中に表示し、停止すると文を出さない", () => {
  let now = 59_000;
  const during = {
    stage: "implement" as const,
    stageLabel: "実装",
    stageStartedAt: 0,
    lastAction: "応答を作成中",
    lastActionAt: null,
  };
  const events: Event[] = [
    {
      type: "user_message",
      payload: { text: "依頼", images: [], origin: "developer" },
      createdAt: 0,
      seq: 1,
    },
    {
      type: "tool_use",
      payload: {
        tool_use_id: "call",
        name: "Read",
        input: { file_path: "/work/src/report.ts" },
        parent_tool_use_id: null,
      },
      createdAt: 55_000,
      seq: 2,
    },
  ];
  const { rerender } = render(
    <WorkingLine activity={liveActivity(during, events, "/work", "working")} now={() => now} />,
  );
  expect(
    screen.getByText("AI が作業中: 実装 1分未満 / 最後にしたこと: Read(src/report.ts)"),
  ).toBeInTheDocument();
  now = 60_000;
  act(() =>
    rerender(
      <WorkingLine activity={liveActivity(during, events, "/work", "working")} now={() => now} />,
    ),
  );
  expect(
    screen.getByText("AI が作業中: 実装 1分 / 最後にしたこと: Read(src/report.ts)"),
  ).toBeInTheDocument();
  rerender(
    <WorkingLine activity={liveActivity(during, events, "/work", "stopped")} now={() => now} />,
  );
  expect(screen.queryByText(/AI が作業中/)).toBeNull();
});
