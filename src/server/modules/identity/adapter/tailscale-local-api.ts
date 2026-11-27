import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type {
  CredentialsFailure,
  TailscaleCredentials,
  TailscaleLocalApiPort,
  WhoisFailure,
  WhoisInput,
  WhoisOwner,
} from "../domain/ports";
import { parseWhoisResponse } from "./whois-response";

const IPN_PORT_PATH = "/Library/Tailscale/ipnport";
const LOCAL_API_HOST = "127.0.0.1";
const LOCAL_API_HOST_HEADER = "local-tailscaled.sock";
const WHOIS_TIMEOUT_MS = 2_000;

export type TailscaleLocalApiOptions = {
  ipnPortPath?: string;
  timeoutMs?: number;
};

export function createTailscaleLocalApi(
  options: TailscaleLocalApiOptions = {},
): TailscaleLocalApiPort {
  const ipnPortPath = options.ipnPortPath ?? IPN_PORT_PATH;
  const timeoutMs = options.timeoutMs ?? WHOIS_TIMEOUT_MS;
  return {
    readCredentials: () => readCredentials(ipnPortPath),
    whois: (input) => whois(input, timeoutMs),
  };
}

async function readCredentials(
  ipnPortPath: string,
): Promise<Result<TailscaleCredentials, CredentialsFailure>> {
  try {
    const portText = await readFile(ipnPortPath, "utf8");
    const port = Number.parseInt(portText.trim(), 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      return err("credentials");
    }
    const password = (await readFile(sameUserProofPath(ipnPortPath, port), "utf8")).trim();
    if (password === "") {
      return err("credentials");
    }
    return ok({ port, password });
  } catch {
    return err("credentials");
  }
}

function sameUserProofPath(ipnPortPath: string, port: number): string {
  return join(dirname(ipnPortPath), `sameuserproof-${port}`);
}

function whois(input: WhoisInput, timeoutMs: number): Promise<Result<WhoisOwner, WhoisFailure>> {
  return new Promise((resolve) => {
    const request = httpRequest(
      {
        host: LOCAL_API_HOST,
        port: input.credentials.port,
        path: `/localapi/v0/whois?addr=${encodeURIComponent(`${input.address}:${input.port}`)}`,
        method: "GET",
        headers: {
          Host: LOCAL_API_HOST_HEADER,
          Authorization: `Basic ${Buffer.from(`:${input.credentials.password}`).toString("base64")}`,
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", () => resolve(err("connection")));
        response.on("end", () => {
          resolve(
            parseWhoisResponse(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")),
          );
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(err("connection"));
    });
    request.on("error", () => resolve(err("connection")));
    request.end();
  });
}
