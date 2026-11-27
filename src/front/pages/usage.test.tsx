import { render, screen } from "@testing-library/react";
import { expect, it } from "vite-plus/test";
import { Layout } from "../buffer/Layout";
import { BufferController } from "../buffer/controller";
import { rateLimitMessage, UsagePage } from "./usage";

it.each([
  { status: "allowed", resetsAt: null, usingOverage: true, expected: "余裕があります" },
  {
    status: "allowed_warning",
    resetsAt: null,
    usingOverage: false,
    expected: "残りが少なくなっています",
  },
  {
    status: "rejected",
    resetsAt: 20,
    usingOverage: false,
    expected: "上限に達しました。15:00 に戻ります",
  },
  { status: "rejected", resetsAt: 20, usingOverage: true, expected: "超過分の利用で続けています" },
] as const)("利用枠の観測を文で示す $status $usingOverage", ({ expected, ...rateLimit }) => {
  expect(rateLimitMessage({ ...rateLimit, observedAt: 10 }, () => "15:00")).toBe(expected);
});

it("プロジェクト・issue・issueの無い会話の桁と料金を表示する", () => {
  render(
    <Layout
      controller={new BufferController()}
      main={
        <UsagePage
          usage={{
            now: 100,
            rateLimit: null,
            projects: [
              {
                projectId: "p",
                name: "在庫",
                total: { tokens5h: 1024, tokens7d: 24_000, costUsd7d: 2.1 },
                issues: [
                  {
                    issueId: "i",
                    number: 12,
                    title: "整理",
                    tokens5h: 1000,
                    tokens7d: 20_000,
                    costUsd7d: 2,
                  },
                ],
                withoutIssue: { tokens5h: 24, tokens7d: 4000, costUsd7d: 0.1 },
              },
            ],
          }}
          formatClock={() => "15:00"}
          formatObserved={() => "11/28 15:00"}
        />
      }
    />,
  );
  const buffer = screen.getByRole("textbox", { name: "バッファ" });
  expect([...buffer.querySelectorAll(".cm-line")].map((line) => line.textContent)).toEqual([
    "利用枠",
    "まだ分かりません。AI が動くと分かります",
    "プロジェクトと issue ごとの利用量",
    "在庫  1,024  24,000  $2.10",
    "  #12 整理  1,000  20,000  $2.00",
    "  issue の無い会話  24  4,000  $0.10",
    "料金の目安は API の料金に換算した値で、サブスクリプションの請求額ではありません",
    "目次などの更新に使った分は含みません",
  ]);
});
