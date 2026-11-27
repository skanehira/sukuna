import {
  serviceLabel,
  type LaunchdPort,
  type ServiceName,
  type RemovedService,
} from "../domain/launchd-port";

export function createRestartServices(launchd: Pick<LaunchdPort, "stop" | "bootstrap">) {
  const stopped = new Map<ServiceName, RemovedService>();
  return {
    async stop(service: ServiceName) {
      await launchd.stop(service, (receipt) => stopped.set(service, receipt));
    },
    async start(targets: readonly ServiceName[]) {
      const results = await Promise.allSettled(
        targets.map(async (service) => {
          try {
            await launchd.bootstrap(service);
            stopped.delete(service);
          } catch (error) {
            throw new Error(`${serviceLabel(service)} を登録できませんでした。`, { cause: error });
          }
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    },
    async recover() {
      const failures = await Promise.all(
        [...stopped.entries()].map(async ([service, receipt]) => {
          try {
            await receipt.waitForExit();
            await launchd.bootstrap(service);
          } catch {
            return serviceLabel(service);
          }
        }),
      );
      const missing = failures.filter((name) => name !== undefined);
      if (missing.length)
        throw new Error(
          `${missing.join("、")} を再登録できませんでした。ログを確かめ、導入のコマンドを実行し直してください。`,
        );
    },
  };
}
