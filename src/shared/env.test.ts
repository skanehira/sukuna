import { describe, expect, it } from "vite-plus/test";
import { readEnvironment } from "./env";

describe("起動の環境変数", () => {
  it.each([
    [
      "runner",
      { NODE_ENV: "production", SUKUNA_AGENT: "fake" },
      "本番では SUKUNA_AGENT を指定できません。",
    ],
    [
      "runner",
      { NODE_ENV: "production", SUKUNA_AGENT_SCRIPT: "/script" },
      "本番では SUKUNA_AGENT_SCRIPT を指定できません。",
    ],
    [
      "runner",
      { NODE_ENV: "production", SUKUNA_GH: "/script" },
      "本番では SUKUNA_GH を指定できません。",
    ],
    [
      "server",
      { NODE_ENV: "production", SUKUNA_GH: "/script" },
      "本番では SUKUNA_GH を指定できません。",
    ],
    [
      "runner",
      { SUKUNA_AGENT: "fake" },
      "SUKUNA_AGENT=fake には読み取り可能な SUKUNA_AGENT_SCRIPT が必要です。",
    ],
    [
      "runner",
      { SUKUNA_AGENT: "fake", SUKUNA_AGENT_SCRIPT: "/missing" },
      "SUKUNA_AGENT=fake には読み取り可能な SUKUNA_AGENT_SCRIPT が必要です。",
    ],
    ["server", { PORT: "bad" }, "PORT は 1〜65535 の整数で指定してください。"],
    ["server", { PORT: "0" }, "PORT は 1〜65535 の整数で指定してください。"],
    ["server", { PORT: "65536" }, "PORT は 1〜65535 の整数で指定してください。"],
    [
      "runner",
      { SUKUNA_RUNNER_SOCKET: "a".repeat(104) },
      "SUKUNA_RUNNER_SOCKET は 103 バイト以内で指定してください。",
    ],
    [
      "server",
      { SUKUNA_RUNNER_SOCKET: "あ".repeat(35) },
      "SUKUNA_RUNNER_SOCKET は 103 バイト以内で指定してください。",
    ],
  ] as const)("%s が不正な設定 %j で起動すると理由を返す", (role, env, message) => {
    expect(readEnvironment(role, env, "/home/test", () => false)._unsafeUnwrapErr()).toEqual({
      message,
    });
  });

  it("本番の画面サーバーはログイン名なしで起動できる", () => {
    expect(
      readEnvironment("server", { NODE_ENV: "production" }, "/home/test", () => false).isOk(),
    ).toBe(true);
  });

  it("既定と有効な偽物の設定を読む", () => {
    expect(
      readEnvironment(
        "runner",
        {
          SUKUNA_AGENT: "fake",
          SUKUNA_AGENT_SCRIPT: "/script",
          SUKUNA_RUNNER_SOCKET: "a".repeat(103),
        },
        "/home/test",
        () => true,
      )._unsafeUnwrap(),
    ).toEqual({
      home: "/home/test/.sukuna",
      socket: "a".repeat(103),
      port: 4580,
      agent: "fake",
      agentScript: "/script",
      ghScript: null,
      logLevel: "info",
    });
    expect(
      readEnvironment(
        "server",
        { NODE_ENV: "production", PORT: "5180" },
        "/home/test",
        () => false,
      )._unsafeUnwrap(),
    ).toEqual({
      home: "/home/test/.sukuna",
      socket: "/home/test/.sukuna/runner.sock",
      port: 5180,
      agent: "real",
      agentScript: null,
      ghScript: null,
      logLevel: "info",
    });
  });
});
