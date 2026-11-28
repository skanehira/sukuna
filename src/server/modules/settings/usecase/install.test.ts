import { expect, it } from "vite-plus/test";
import { installApplication, updateApplication } from "./install";
import type { LaunchdPort } from "../domain/launchd-port";

const config = {
  repository: "/repo/sukuna",
  node: "/bin/node",
  stateDirectory: "/state/sukuna",
  userHome: "/home/dev",
  port: 4580,
  path: "/bin",
  terminal: {},
};

it("同じ導入を二回行うと同じplistが登録され、通常更新はサーバーだけ入れ替える", async () => {
  const plist = new Map<string, string>();
  const trace: string[] = [];
  let installedHash: string | undefined;
  let hash = "one";
  const launchd: LaunchdPort = {
    registered: async () => true,
    pid: async () => 1345,
    stop: async (service) => {
      trace.push(`stop ${service}`);
    },
    bootstrap: async (service) => {
      trace.push(`start ${service}`);
    },
    kickstart: async (service, replace) => {
      trace.push(`kickstart ${service} ${replace}`);
    },
  };
  const files = {
    prepare: () => {
      trace.push("prepare");
    },
    writePlist: (service: string, value: string) => {
      plist.set(service, value);
    },
    readRunnerHash: () => installedHash,
    writeRunnerHash: (value: string) => {
      installedHash = value;
    },
    runnerHash: () => Promise.resolve(hash),
  };
  const deps = {
    files,
    launchd,
    output: (message: string) => trace.push(message),
    dnsName: async () => "studio.example.test",
    ready: async () => [],
  };

  await installApplication(config, deps);
  const first = { trace: trace.splice(0), plist: Array.from(plist.entries()) };
  await installApplication(config, deps);
  expect(trace.splice(0)).toEqual(first.trace);
  expect(Array.from(plist.entries())).toEqual(first.plist);
  expect(first.trace).toEqual([
    "prepare",
    "stop runner",
    "stop server",
    "stop restore",
    "start runner",
    "start server",
    "start restore",
    "http://studio.example.test:4580",
  ]);
  expect(installedHash).toBe("one");

  hash = "two";
  await updateApplication(false, deps);
  expect(trace).toEqual([
    "kickstart server true",
    "ランナーのコードが変わりました。動いている AI を止めてよいときに install.js update --runner を実行してください。",
  ]);
  expect(installedHash).toBe("one");
});

it("待ち受けを確認できないときは導入と両サービス更新で前のハッシュを保つ", async () => {
  const actions: string[] = [];
  let hash = "old";
  const deps = {
    files: {
      prepare() {},
      writePlist() {},
      readRunnerHash: () => hash,
      writeRunnerHash(value: string) {
        hash = value;
      },
      runnerHash: async () => "new",
    },
    launchd: {
      registered: async () => true,
      pid: async () => 1345,
      stop: async (service: string) => {
        actions.push(`stop ${service}`);
      },
      bootstrap: async (service: string) => {
        actions.push(`start ${service}`);
      },
      kickstart: async (service: string) => {
        actions.push(`kickstart ${service}`);
      },
    },
    output: (message: string) => {
      actions.push(message);
    },
    dnsName: async () => "studio.example.test",
    ready: async () => ["runner" as const],
  };
  await expect(installApplication(config, deps)).rejects.toThrow("起動を確認");
  expect(hash).toBe("old");
  await expect(updateApplication(true, deps)).rejects.toThrow("起動を確認");
  expect(hash).toBe("old");
  expect(actions.filter((entry) => entry.startsWith("http"))).toEqual([]);
});
