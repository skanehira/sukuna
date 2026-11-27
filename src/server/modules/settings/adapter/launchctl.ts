import type { CommandResult } from "../../../../shared/command";
import { serviceLabel, type LaunchdPort, type ServiceName } from "../domain/launchd-port";

type Run = (args: string[]) => Promise<CommandResult>;
type Options = {
  uid: number;
  plist: (service: ServiceName) => string;
  run: Run;
  alive(pid: number): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
};

function assertSucceeded(args: string[], result: CommandResult): void {
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || `終了コード ${result.exitCode}`;
    throw new Error(`launchctl ${args[0]} に失敗しました。 ${reason}`);
  }
}

export function createLaunchctl(options: Options): LaunchdPort {
  const domain = `gui/${options.uid}`;
  const target = (service: ServiceName) => `${domain}/${serviceLabel(service)}`;
  const inspect = async (service: ServiceName) => {
    const args = ["print", target(service)];
    const result = await options.run(args);
    if (result.exitCode === 113 || /could not find service|no such process/i.test(result.stderr))
      return null;
    assertSucceeded(args, result);
    return { pid: Number(/^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1]) || null };
  };
  return {
    registered: async (service) => (await inspect(service)) !== null,
    pid: async (service) => (await inspect(service))?.pid ?? null,
    async bootstrap(service) {
      const args = ["bootstrap", domain, options.plist(service)];
      assertSucceeded(args, await options.run(args));
    },
    async stop(service, removed) {
      const job = await inspect(service);
      if (job === null) return;
      const args = ["bootout", target(service)];
      assertSucceeded(args, await options.run(args));
      const pid = job.pid;
      const receipt = {
        async waitForExit() {
          if (pid === null) return;
          const start = options.now();
          while (options.alive(pid)) {
            if (options.now() - start >= 25_000)
              throw new Error(`サービス ${serviceLabel(service)} の終了を確認できませんでした。`);
            await options.sleep(250);
          }
        },
      };
      removed?.(receipt);
      await receipt.waitForExit();
    },
    async kickstart(service, replace = false) {
      const args = [
        "kickstart",
        ...(replace ? ["-k"] : []),
        ...(service === "restore" ? ["-p"] : []),
        target(service),
      ];
      const result = await options.run(args);
      assertSucceeded(args, result);
      if (service === "restore") {
        const pid = /^\d+$/.test(result.stdout.trim())
          ? Number(result.stdout.trim())
          : (await inspect(service))?.pid;
        if (pid && Number.isSafeInteger(pid)) return pid;
      }
    },
  };
}
