import { err, type Result } from "neverthrow";
import { isTailscaleAddress, normalizeIpv4, type IdentityDecision } from "../domain/identity";
import type {
  ClockPort,
  CredentialsFailure,
  TailscaleLocalApiPort,
  WhoisFailure,
  WhoisOwner,
} from "../domain/ports";

const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1"]);
const LOCAL_DEVICE = "local";
const CACHE_TTL_MS = 60_000;

export type ResolveIdentity = (source: {
  address: string;
  port: number;
}) => Promise<IdentityDecision>;

export type ResolveIdentityDeps = {
  login: string | undefined;
  devIdentity: string | undefined;
  tailscale: TailscaleLocalApiPort;
  clock: ClockPort;
};

export function createResolveIdentity(deps: ResolveIdentityDeps): ResolveIdentity {
  const remembered = new Map<string, { owner: WhoisOwner; at: number }>();

  return async ({ address, port }) => {
    const ip = normalizeIpv4(address);
    if (LOCAL_ADDRESSES.has(ip) && deps.devIdentity !== undefined) {
      return { allowed: true, identity: { login: deps.devIdentity, device: LOCAL_DEVICE } };
    }
    if (!isTailscaleAddress(ip)) {
      return { allowed: false, reason: "identity" };
    }

    const now = deps.clock.now();
    const hit = remembered.get(ip);
    if (hit !== undefined && now - hit.at <= CACHE_TTL_MS) {
      return decide(hit.owner, deps.login);
    }

    const outcome = await lookUpOwner(deps.tailscale, ip, port);
    if (outcome.kind === "owner") {
      remembered.set(ip, { owner: outcome.owner, at: now });
      return decide(outcome.owner, deps.login);
    }
    return { allowed: false, reason: outcome.kind };
  };
}

function decide(owner: WhoisOwner, login: string | undefined): IdentityDecision {
  if (login === undefined || owner.loginName !== login) {
    return { allowed: false, reason: "identity" };
  }
  return { allowed: true, identity: { login: owner.loginName, device: owner.deviceName } };
}

type LookUpOutcome =
  | { kind: "owner"; owner: WhoisOwner }
  | { kind: "identity" }
  | { kind: "unavailable" };

async function lookUpOwner(
  tailscale: TailscaleLocalApiPort,
  address: string,
  port: number,
): Promise<LookUpOutcome> {
  const first = await attempt(tailscale, address, port);
  if (first.isOk()) {
    return { kind: "owner", owner: first.value };
  }
  if (first.error === "not_found") {
    return { kind: "identity" };
  }
  if (first.error !== "auth" && first.error !== "connection") {
    return { kind: "unavailable" };
  }
  const retry = await attempt(tailscale, address, port);
  if (retry.isOk()) {
    return { kind: "owner", owner: retry.value };
  }
  if (retry.error === "not_found") {
    return { kind: "identity" };
  }
  return { kind: "unavailable" };
}

async function attempt(
  tailscale: TailscaleLocalApiPort,
  address: string,
  port: number,
): Promise<Result<WhoisOwner, WhoisFailure | CredentialsFailure>> {
  const credentials = await tailscale.readCredentials();
  if (credentials.isErr()) {
    return err(credentials.error);
  }
  return tailscale.whois({ address, port, credentials: credentials.value });
}
