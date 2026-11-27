import type { RestoreRequest, RestoreStatus } from "../../../../shared/settings/restore-schema";
import {
  persistentServices,
  serviceLabel,
  type LaunchdPort,
  type ServiceReadiness,
} from "../domain/launchd-port";
import { createRestartServices } from "./restart-services";

type RestoreFiles = {
  lockWorker(): Promise<{ release(): void } | null>;
  readRequest(): RestoreRequest | undefined;
  clearRequest(request: RestoreRequest): void;
  recordResult(result: RestoreStatus): void;
  replace(request: RestoreRequest, result: RestoreStatus): Promise<void>;
  recordDatabaseResult(value: RestoreStatus): Promise<void>;
};

type RestoreDependencies = {
  files: RestoreFiles;
  services: Pick<LaunchdPort, "stop" | "bootstrap">;
  ready: ServiceReadiness;
  now(): number;
  sleep(ms: number): Promise<void>;
  rotate?: () => void;
  warning?: (kind: "log" | "receipt" | "database" | "services", error: unknown) => void;
};

export async function runRestore(
  deps: RestoreDependencies,
): Promise<RestoreStatus | { status: "idle" }> {
  const lock = await deps.files.lockWorker();
  if (!lock) throw new Error("復元の処理を確保できませんでした。");
  try {
    const request = deps.files.readRequest();
    if (!request) return { status: "idle" };
    try {
      deps.rotate?.();
    } catch (error) {
      deps.warning?.("log", error);
    }
    return await restoreRequest(request, deps);
  } finally {
    lock.release();
  }
}

async function restoreRequest(
  request: RestoreRequest,
  deps: RestoreDependencies,
): Promise<RestoreStatus> {
  const { files } = deps;
  const jobs = createRestartServices(deps.services);
  const timestamp = () => Math.max(deps.now(), request.requestedAt);
  let restored = false;
  let result: RestoreStatus = {
    backupId: request.backupId,
    at: timestamp(),
    status: "done",
    message: null,
    ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
  };
  try {
    await deps.sleep(2_000);
    for (const service of persistentServices) await jobs.stop(service);
    await files.replace(request, {
      ...result,
      at: timestamp(),
      status: "failed",
      message: "データベースを復元しましたが、サービスの起動を確認する前に処理が止まりました。",
    });
    restored = true;
    await jobs.start(persistentServices);
    const missing = await deps.ready(persistentServices);
    if (missing.length > 0)
      throw new Error(`${missing.map(serviceLabel).join("、")} の起動を確認できませんでした。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.status = "failed";
    result.message = restored ? `データベースを復元しましたが、${message}` : message;
    if (!restored) {
      try {
        await jobs.recover();
      } catch (recovery) {
        deps.warning?.("services", recovery);
      }
    }
  }
  result.at = timestamp();
  try {
    await files.recordDatabaseResult(result);
  } catch (error) {
    deps.warning?.("database", error);
    if (result.status === "done") {
      result = {
        ...result,
        status: "failed",
        message:
          "データベースとサービスを復元しましたが、データベースに完了結果を保存できませんでした。",
      };
    }
  }
  try {
    files.recordResult(result);
  } catch (error) {
    deps.warning?.("receipt", error);
  }
  files.clearRequest(request);
  return result;
}
