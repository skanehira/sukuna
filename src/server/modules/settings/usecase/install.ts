import { launchdPlist, type LaunchdPlistConfig } from "../domain/launchd-plist";
import {
  persistentServices,
  services,
  serviceLabel,
  type LaunchdPort,
  type ServiceReadiness,
  type PersistentService,
  type ServiceName,
} from "../domain/launchd-port";
import { createRestartServices } from "./restart-services";

type InstallFiles = {
  prepare(): void;
  writePlist(service: ServiceName, content: string): void;
  readRunnerHash(): string | undefined;
  writeRunnerHash(hash: string): void;
  runnerHash(): Promise<string>;
};

type UpdateDependencies = {
  files: InstallFiles;
  launchd: LaunchdPort;
  output(message: string): void;
  ready: ServiceReadiness;
};

async function replaceServices(launchd: LaunchdPort, targets: readonly ServiceName[]) {
  const jobs = createRestartServices(launchd);
  try {
    for (const service of targets) await jobs.stop(service);
    await jobs.start(targets);
  } catch (error) {
    await jobs.recover();
    throw error;
  }
}

async function requireReady(deps: UpdateDependencies, targets: readonly PersistentService[]) {
  const missing = await deps.ready(targets);
  if (missing.length > 0)
    throw new Error(
      `30 秒以内に ${missing.map(serviceLabel).join("、")} の起動を確認できませんでした。`,
    );
}

export async function installApplication(
  config: LaunchdPlistConfig,
  deps: UpdateDependencies & {
    identity(): Promise<{ login: string; dns: string } | null>;
  },
): Promise<void> {
  const hash = await deps.files.runnerHash();
  deps.files.prepare();
  const identity = await deps.identity();
  if (identity === null) {
    deps.output("Tailscale のログイン名と MagicDNS を取得できませんでした。");
  } else if (identity.login !== config.login) {
    deps.output("指定したログイン名が、この Mac の Tailscale のログイン名と異なります。");
  }
  for (const service of services) deps.files.writePlist(service, launchdPlist(service, config));
  await replaceServices(deps.launchd, services);
  await requireReady(deps, persistentServices);
  deps.files.writeRunnerHash(hash);
  if (identity?.dns) deps.output(`http://${identity.dns}:${config.port}`);
}

export async function updateApplication(
  includeRunner: boolean,
  deps: UpdateDependencies,
): Promise<void> {
  const hash = await deps.files.runnerHash();
  if (!includeRunner) {
    await deps.launchd.kickstart("server", true);
    await requireReady(deps, ["server"]);
    if (deps.files.readRunnerHash() !== hash)
      deps.output(
        "ランナーのコードが変わりました。動いている AI を止めてよいときに install.js update --runner を実行してください。",
      );
    return;
  }
  await replaceServices(deps.launchd, persistentServices);
  await requireReady(deps, persistentServices);
  deps.files.writeRunnerHash(hash);
}

export async function uninstallApplication(deps: {
  launchd: Pick<LaunchdPort, "stop">;
  removePlist(service: ServiceName): void;
}): Promise<void> {
  for (const service of [...services].reverse()) {
    await deps.launchd.stop(service);
    deps.removePlist(service);
  }
}
