export type ServiceName = "server" | "runner" | "restore";

export const serviceLabel = (service: ServiceName) => `dev.sukuna.${service}`;
export const services = ["runner", "server", "restore"] as const;
export const persistentServices = ["runner", "server"] as const;
export type PersistentService = (typeof persistentServices)[number];
export type ServiceReadiness = (
  targets: readonly PersistentService[],
) => Promise<readonly PersistentService[]>;

export type RemovedService = { waitForExit(): Promise<void> };

export interface LaunchdPort {
  registered(service: ServiceName): Promise<boolean>;
  pid(service: ServiceName): Promise<number | null>;
  bootstrap(service: ServiceName): Promise<void>;
  stop(service: ServiceName, removed?: (receipt: RemovedService) => void): Promise<void>;
  kickstart(service: ServiceName, replace?: boolean): Promise<number | void>;
}
