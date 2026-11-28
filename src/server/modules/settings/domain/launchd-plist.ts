import { serviceLabel, type ServiceName } from "./launchd-port";

export type LaunchdPlistConfig = {
  repository: string;
  node: string;
  home: string;
  userHome: string;
  port: number;
  path: string;
  claudeConfigDir?: string;
};

const escaped: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
const xml = (value: string) => value.replace(/[&<>"']/g, (char) => escaped[char]!);
const key = (value: string) => `<key>${xml(value)}</key>`;
const string = (value: string) => `<string>${xml(value)}</string>`;
const entry = (name: string, value: string) => key(name) + value;

export function launchdPlist(service: ServiceName, config: LaunchdPlistConfig): string {
  const persistent = service !== "restore";
  const script = service === "restore" ? "server/install" : `${service}/main`;
  const args = [config.node, `${config.repository}/dist/${script}.js`];
  if (service === "restore") args.push("restore");
  const env = {
    NODE_ENV: "production",
    PORT: String(config.port),
    SUKUNA_HOME: config.home,
    HOME: config.userHome,
    PATH: config.path,
    ...(config.claudeConfigDir === undefined ? {} : { CLAUDE_CONFIG_DIR: config.claudeConfigDir }),
  };
  const log = `${config.home}/logs/${service}.log`;
  const behavior = persistent ? "<true/>" : "<false/>";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    entry("Label", string(serviceLabel(service))),
    entry("ProgramArguments", `<array>${args.map(string).join("")}</array>`),
    entry("WorkingDirectory", string(config.repository)),
    entry(
      "EnvironmentVariables",
      `<dict>${Object.entries(env)
        .map(([name, value]) => entry(name, string(value)))
        .join("")}</dict>`,
    ),
    entry("RunAtLoad", behavior),
    entry("KeepAlive", behavior),
    ...(persistent
      ? [
          entry("ThrottleInterval", "<integer>10</integer>"),
          entry("ExitTimeOut", "<integer>20</integer>"),
        ]
      : []),
    entry("StandardOutPath", string(log)),
    entry("StandardErrorPath", string(log)),
    "</dict></plist>",
    "",
  ].join("\n");
}
