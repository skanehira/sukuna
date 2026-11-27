import type { HttpBindings } from "@hono/node-server";
import { ok, type Result } from "neverthrow";
import type { IncomingMessage } from "node:http";
import type {
  ClockPort,
  CredentialsFailure,
  TailscaleCredentials,
  TailscaleLocalApiPort,
  WhoisFailure,
  WhoisInput,
  WhoisOwner,
} from "./domain/ports";

export type TailscaleFakeOptions = {
  readCredentials?: () => Promise<Result<TailscaleCredentials, CredentialsFailure>>;
  whois?: (input: WhoisInput) => Promise<Result<WhoisOwner, WhoisFailure>>;
};

export type TailscaleFake = {
  api: TailscaleLocalApiPort;
  whoisCalls: WhoisInput[];
  credentialReads: () => number;
};

export function createTailscaleFake(options: TailscaleFakeOptions = {}): TailscaleFake {
  const whoisCalls: WhoisInput[] = [];
  let credentialReads = 0;
  const readCredentials =
    options.readCredentials ??
    (async () => ok<TailscaleCredentials, CredentialsFailure>({ port: 4580, password: "proof" }));
  const whois =
    options.whois ??
    (async () =>
      ok<WhoisOwner, WhoisFailure>({ loginName: "dev@example.com", deviceName: "macbook-air" }));

  return {
    api: {
      readCredentials: async () => {
        credentialReads += 1;
        return readCredentials();
      },
      whois: async (input) => {
        whoisCalls.push(input);
        return whois(input);
      },
    },
    whoisCalls,
    credentialReads: () => credentialReads,
  };
}

export type ClockFake = ClockPort & { set(now: number): void };

export function createClockFake(start = 0): ClockFake {
  let now = start;
  return {
    now: () => now,
    set: (value: number) => {
      now = value;
    },
  };
}

export function incomingMessageWith(address: string, port: number): IncomingMessage {
  return { socket: { remoteAddress: address, remotePort: port } } as unknown as IncomingMessage;
}

export function incomingWith(address: string, port: number): HttpBindings {
  return { incoming: incomingMessageWith(address, port) } as unknown as HttpBindings;
}
