import { createServer } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createTempHome, removeTempHome } from "../../../../shared/db/test-helpers";
import { launchdReadiness } from "./launchd-readiness";

it.each([null, "server", "runner"] as const)(
  "接続先が更新したサービスのPIDと一致した場合だけ起動成功にする (競合=%s)",
  async (foreign) => {
    const home = createTempHome();
    const socket = join(home, "runner.sock");
    const tcp = createServer((client) => client.end());
    const unix = createServer((client) => client.end());
    tcp.listen(0, "127.0.0.1");
    unix.listen(socket);
    try {
      await Promise.all([once(tcp, "listening"), once(unix, "listening")]);
      const port = (tcp.address() as AddressInfo).port;
      let now = 0;
      const openFiles = async (args: string[]) => {
        if (args.includes(`-i4TCP:${port}`)) {
          expect(args).toContain("-sTCP:LISTEN");
          expect(args).toContain("44");
          return { stdout: foreign === "server" ? "p99\n" : "p44\n", stderr: "", exitCode: 0 };
        }
        expect(args).toContain("-U");
        expect(args).toContain("45");
        return {
          stdout: `p45\nn${foreign === "runner" ? join(home, "other.sock") : socket} type=STREAM\n`,
          stderr: "",
          exitCode: 0,
        };
      };
      const check = launchdReadiness({
        launchd: { pid: async (name) => (name === "server" ? 44 : 45) },
        port,
        socket,
        openFiles,
        now: () => now,
        sleep: async () => {
          now += 30_000;
        },
      });
      expect(await check(["server", "runner"])).toEqual(foreign === null ? [] : [foreign]);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => tcp.close(() => resolve())),
        new Promise<void>((resolve) => unix.close(() => resolve())),
      ]);
      removeTempHome(home);
    }
  },
);
