import { expect, it } from "vite-plus/test";
import { launchdPlist } from "./launchd-plist";

const config = {
  repository: "/code/sukuna",
  node: "/bin/node",
  stateDirectory: "/state/sukuna",
  userHome: "/home/developer",
  port: 4580,
  path: "/bin:/tools",
  claudeConfigDir: "/data/a & b",
  terminal: {
    XDG_DATA_HOME: "/xdg/data",
    XDG_STATE_HOME: "/xdg/state",
    XDG_RUNTIME_DIR: "/xdg/run",
    SUKUNA_AGENT: "fake",
  },
};

const environmentOf = (plist: string) =>
  plist.match(/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s)?.[1];
const logsOf = (plist: string) => [
  plist.match(/<key>StandardOutPath<\/key><string>(.*?)<\/string>/)?.[1],
  plist.match(/<key>StandardErrorPath<\/key><string>(.*?)<\/string>/)?.[1],
];

it("本番用の常駐プロセスと必要時だけ起動する復元の plist を生成する", () => {
  const server = launchdPlist("server", config);
  expect(server).toContain("<string>/bin/node</string>");
  expect(server).toContain("<string>/code/sukuna/dist/server/main.js</string>");
  expect(server).toContain("<key>RunAtLoad</key><true/>");
  expect(server).toContain("<key>KeepAlive</key><true/>");
  expect(server).toContain("<key>ExitTimeOut</key><integer>20</integer>");
  expect(environmentOf(server)).toBe(
    "<key>NODE_ENV</key><string>production</string>" +
      "<key>PORT</key><string>4580</string>" +
      "<key>HOME</key><string>/home/developer</string>" +
      "<key>PATH</key><string>/bin:/tools</string>" +
      "<key>CLAUDE_CONFIG_DIR</key><string>/data/a &amp; b</string>" +
      "<key>XDG_DATA_HOME</key><string>/xdg/data</string>" +
      "<key>XDG_STATE_HOME</key><string>/xdg/state</string>" +
      "<key>XDG_RUNTIME_DIR</key><string>/xdg/run</string>",
  );
  const restore = launchdPlist("restore", config);
  expect(restore).toContain("<string>/code/sukuna/dist/server/install.js</string>");
  expect(restore).toContain("<string>restore</string>");
  expect(restore).toContain("<key>KeepAlive</key><false/>");
  expect(restore).toContain("<key>RunAtLoad</key><false/>");
});

it("導入した端末に XDG の環境変数が無ければ、plist にも書かない", () => {
  expect(environmentOf(launchdPlist("server", { ...config, terminal: {} }))).toBe(
    "<key>NODE_ENV</key><string>production</string>" +
      "<key>PORT</key><string>4580</string>" +
      "<key>HOME</key><string>/home/developer</string>" +
      "<key>PATH</key><string>/bin:/tools</string>" +
      "<key>CLAUDE_CONFIG_DIR</key><string>/data/a &amp; b</string>",
  );
});

it.each([
  ["server", "/state/sukuna/logs/server.log"],
  ["runner", "/state/sukuna/logs/runner.log"],
  ["restore", "/state/sukuna/logs/restore.log"],
] as const)("%s のログは状態のディレクトリの logs に書く", (service, log) => {
  expect(logsOf(launchdPlist(service, config))).toEqual([log, log]);
});
