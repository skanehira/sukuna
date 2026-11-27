import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { err, ok } from "neverthrow";
import { createTailscaleLocalApi } from "./tailscale-local-api";

const CREDENTIALS_PORT = 4580;

describe("createTailscaleLocalApi の readCredentials", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function writeCredentialFiles(files: { ipnport?: string; password?: string }): string {
    const dir = mkdtempSync(join(tmpdir(), "sukuna-tailscale-"));
    dirs.push(dir);
    if (files.ipnport !== undefined) {
      writeFileSync(join(dir, "ipnport"), files.ipnport);
    }
    if (files.password !== undefined) {
      writeFileSync(join(dir, `sameuserproof-${CREDENTIALS_PORT}`), files.password);
    }
    return join(dir, "ipnport");
  }

  it("ipnport のポート番号と sameuserproof-<ポート> のパスワードを読む", async () => {
    const ipnPortPath = writeCredentialFiles({ ipnport: "4580\n", password: " proof \n" });

    const credentials = await createTailscaleLocalApi({ ipnPortPath }).readCredentials();

    expect(credentials).toEqual(ok({ port: CREDENTIALS_PORT, password: "proof" }));
  });

  it("ipnport が読めないときは credentials として返す", async () => {
    const ipnPortPath = writeCredentialFiles({});

    const credentials = await createTailscaleLocalApi({ ipnPortPath }).readCredentials();

    expect(credentials).toEqual(err("credentials"));
  });

  it.each(["", "abc", "0", "-1", "65536"])(
    "ipnport の中身 %s がポート番号として読めないときは credentials として返す",
    async (ipnport) => {
      const ipnPortPath = writeCredentialFiles({ ipnport });

      const credentials = await createTailscaleLocalApi({ ipnPortPath }).readCredentials();

      expect(credentials).toEqual(err("credentials"));
    },
  );

  it("sameuserproof-<ポート> が読めないときは credentials として返す", async () => {
    const ipnPortPath = writeCredentialFiles({ ipnport: "4580\n" });

    const credentials = await createTailscaleLocalApi({ ipnPortPath }).readCredentials();

    expect(credentials).toEqual(err("credentials"));
  });

  it("sameuserproof-<ポート> が空のときは credentials として返す", async () => {
    const ipnPortPath = writeCredentialFiles({ ipnport: "4580\n", password: " \n" });

    const credentials = await createTailscaleLocalApi({ ipnPortPath }).readCredentials();

    expect(credentials).toEqual(err("credentials"));
  });
});

describe("createTailscaleLocalApi の whois", () => {
  let server: Server | undefined;
  const sockets = new Set<Socket>();

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  async function startServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<number> {
    const httpServer = createServer(handler);
    httpServer.on("connection", (socket) => sockets.add(socket));
    server = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    return (httpServer.address() as AddressInfo).port;
  }

  function whoisInput(port: number) {
    return { address: "100.64.0.7", port: 4321, credentials: { port, password: "proof" } };
  }

  it("接続元のアドレスとポートを whois に渡し、Basic 認証と Host を付けて呼ぶ", async () => {
    const requests: {
      method: string | undefined;
      url: string | undefined;
      host: string | undefined;
      authorization: string | undefined;
    }[] = [];
    const port = await startServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          UserProfile: { LoginName: "dev@example.com" },
          Node: { ComputedName: "macbook-air" },
        }),
      );
    });

    const owner = await createTailscaleLocalApi().whois(whoisInput(port));

    expect(owner).toEqual(ok({ loginName: "dev@example.com", deviceName: "macbook-air" }));
    expect(requests).toEqual([
      {
        method: "GET",
        url: "/localapi/v0/whois?addr=100.64.0.7%3A4321",
        host: "local-tailscaled.sock",
        authorization: `Basic ${Buffer.from(":proof").toString("base64")}`,
      },
    ]);
  });

  it("ローカル API が 401 を返すときは auth として返す", async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(401);
      response.end();
    });

    const owner = await createTailscaleLocalApi().whois(whoisInput(port));

    expect(owner).toEqual(err("auth"));
  });

  it("ローカル API に接続できないときは connection として返す", async () => {
    const httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    const owner = await createTailscaleLocalApi().whois(whoisInput(port));

    expect(owner).toEqual(err("connection"));
  });

  it("ローカル API が応答しないときは connection として返す", async () => {
    const port = await startServer(() => undefined);

    const owner = await createTailscaleLocalApi({ timeoutMs: 20 }).whois(whoisInput(port));

    expect(owner).toEqual(err("connection"));
  });

  it("ローカル API が本文の途中で接続を切ったときも connection として返す", async () => {
    const port = await startServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.write('{"UserProfile":');
      setImmediate(() => response.destroy());
    });

    const owner = await createTailscaleLocalApi({ timeoutMs: 20 }).whois(whoisInput(port));

    expect(owner).toEqual(err("connection"));
  }, 1_000);
});
