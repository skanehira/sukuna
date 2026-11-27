import type { Result } from "neverthrow";

export type TailscaleCredentials = {
  port: number;
  password: string;
};

export type CredentialsFailure = "credentials";

export type WhoisOwner = {
  loginName: string;
  deviceName: string;
};

export type WhoisFailure = "auth" | "connection" | "not_found" | "invalid_response";

export type WhoisInput = {
  address: string;
  port: number;
  credentials: TailscaleCredentials;
};

export interface TailscaleLocalApiPort {
  readCredentials(): Promise<Result<TailscaleCredentials, CredentialsFailure>>;
  whois(input: WhoisInput): Promise<Result<WhoisOwner, WhoisFailure>>;
}

export interface ClockPort {
  now(): number;
}
