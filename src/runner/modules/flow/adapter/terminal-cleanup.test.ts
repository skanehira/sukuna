import { describe, expect, it } from "vite-plus/test";
import type { TerminalCleanupRequest } from "../../../../shared/ipc";
import { createImplementationTerminalCleanup } from "./terminal-cleanup";

function fixture() {
  let captured: TerminalCleanupRequest | undefined;
  let time = 10_000;
  let expire: (() => void) | undefined;
  const broker = createImplementationTerminalCleanup(
    {
      terminalCleanupAvailable: true,
      publish: (notice) => {
        if (notice.kind === "worktree_terminal_close") captured = notice;
      },
    },
    {
      now: () => time,
      setTimeout: (callback) => {
        expire = callback;
        return () => {
          expire = undefined;
        };
      },
    },
    () => "00000000-0000-4000-8000-000000000001",
  );
  return {
    broker,
    timeout() {
      time += 8_000;
      expire?.();
    },
    async reply(step: "claim" | "closed" | "defer", worktree?: string) {
      if (!captured) throw new Error("終了依頼がありません");
      const r = await broker.app.request("/terminal-cleanup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: captured.request_id,
          worktree_id: worktree ?? captured.worktree_id,
          directory_key: captured.directory_key,
          step,
        }),
      });
      return r.status;
    },
  };
}

describe("自動片付けの管理端末の終了確認", () => {
  it("別作業場所や受理前の応答を受けず、同じ依頼の終了だけを受ける", async () => {
    const f = fixture();
    const result = f.broker.close("expected", "/fixture", "1:2");
    try {
      expect(await f.reply("claim", "different")).toBe(409);
      expect(await f.reply("closed")).toBe(409);
      expect(await f.reply("claim")).toBe(200);
      expect(await f.reply("claim")).toBe(409);
      expect(await f.reply("closed")).toBe(200);
      expect(await result).toBe("closed");
      expect(await f.reply("closed")).toBe(409);
    } finally {
      f.broker.stop();
    }
  });

  it("ランナーが止まると保留中の削除を許可せず、旧依頼への応答も受けない", async () => {
    const f = fixture();
    const result = f.broker.close("expected", "/fixture", "1:2");
    expect(await f.reply("claim")).toBe(200);
    f.broker.stop();
    expect(await result).toBe("deferred");
    expect(await f.reply("closed")).toBe(409);
  });
  it("終了確認の期限を過ぎると削除を保留し、遅れた確認を拒否する", async () => {
    const f = fixture();
    try {
      const result = f.broker.close("expected", "/fixture", "1:2");
      expect(await f.reply("claim")).toBe(200);
      f.timeout();
      expect(await result).toBe("deferred");
      expect(await f.reply("closed")).toBe(409);
    } finally {
      f.broker.stop();
    }
  });
});
