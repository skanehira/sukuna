import { expect, it } from "vite-plus/test";
import { launchdPlist } from "./launchd-plist";

const config = {
  repository: "/code/sukuna",
  node: "/bin/node",
  home: "/data/sukuna",
  userHome: "/home/developer",
  port: 4580,
  login: "dev@example.com",
  path: "/bin:/tools",
  claudeConfigDir: "/data/a & b",
  SUKUNA_DEV_IDENTITY: "test",
  SUKUNA_AGENT: "fake",
};

it("本番用の常駐プロセスと必要時だけ起動する復元の plist を生成する", () => {
  const server = launchdPlist("server", config);
  expect(server).toContain("<string>/bin/node</string>");
  expect(server).toContain("<string>/code/sukuna/dist/server/main.js</string>");
  expect(server).toContain("<key>RunAtLoad</key><true/>");
  expect(server).toContain("<key>KeepAlive</key><true/>");
  expect(server).toContain("<key>ExitTimeOut</key><integer>20</integer>");
  expect(server.match(/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s)?.[1]).toBe(
    "<key>NODE_ENV</key><string>production</string>" +
      "<key>PORT</key><string>4580</string>" +
      "<key>SUKUNA_HOME</key><string>/data/sukuna</string>" +
      "<key>SUKUNA_LOGIN</key><string>dev@example.com</string>" +
      "<key>HOME</key><string>/home/developer</string>" +
      "<key>PATH</key><string>/bin:/tools</string>" +
      "<key>CLAUDE_CONFIG_DIR</key><string>/data/a &amp; b</string>",
  );
  const restore = launchdPlist("restore", config);
  expect(restore).toContain("<string>/code/sukuna/dist/server/install.js</string>");
  expect(restore).toContain("<string>restore</string>");
  expect(restore).toContain("<key>KeepAlive</key><false/>");
  expect(restore).toContain("<key>RunAtLoad</key><false/>");
});
