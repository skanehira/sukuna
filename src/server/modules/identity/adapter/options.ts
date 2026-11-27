import type { ResolveIdentityDeps } from "../usecase/resolve-identity";
import { createTailscaleLocalApi } from "./tailscale-local-api";

export type IdentityOptions = ResolveIdentityDeps;

export function defaultIdentityOptions(): IdentityOptions {
  return {
    login: process.env.SUKUNA_LOGIN,
    devIdentity: process.env.SUKUNA_DEV_IDENTITY,
    tailscale: createTailscaleLocalApi(),
    clock: { now: () => Date.now() },
  };
}
