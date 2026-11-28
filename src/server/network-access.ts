import { execFile } from "node:child_process";
import { BlockList, isIP, isIPv4, type Socket } from "node:net";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";

const allowedIPv4 = new BlockList();
allowedIPv4.addAddress("127.0.0.1");
allowedIPv4.addSubnet("100.64.0.0", 10);

const localStatus = z.object({ Self: z.object({ DNSName: z.string() }) });
const exec = promisify(execFile);
const normalizeHostname = (name: string) => name.toLowerCase().replace(/\.$/, "");

export async function tailscaleDnsName(): Promise<string | null> {
  const status = (command: string) =>
    exec(command, ["status", "--json", "--peers=false"], {
      timeout: 2_000,
      env: { ...process.env, TAILSCALE_BE_CLI: "1" },
    });
  try {
    const { stdout } = await status("tailscale").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && process.platform === "darwin")
        return status("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
      throw error;
    });
    return normalizeHostname(localStatus.parse(JSON.parse(stdout)).Self.DNSName) || null;
  } catch {
    return null;
  }
}

export async function serverHostnames(): Promise<Set<string>> {
  const own = normalizeHostname(hostname());
  const short = own.split(".", 1)[0]!;
  const names = new Set([own, short, short + ".local"]);
  const magicDns = await tailscaleDnsName();
  if (magicDns) {
    names.add(magicDns);
    names.add(magicDns.split(".", 1)[0]!);
  }
  return names;
}

export function allowsRequestAuthority(
  authority: string | undefined,
  hostnames: ReadonlySet<string>,
): boolean {
  if (!authority || /[\s/\\?#@]/.test(authority)) return false;
  try {
    const host = normalizeHostname(new URL("http://" + authority).hostname);
    return (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      isIP(host.replace(/^\[|\]$/g, "")) !== 0 ||
      hostnames.has(host)
    );
  } catch {
    return false;
  }
}

export function allowsClientAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false;
  const address = remoteAddress.replace(/^::ffff:/i, "");
  return address === "::1" || (isIPv4(address) && allowedIPv4.check(address));
}

export function restrictNetworkAccess(server: {
  on(event: "connection", listener: (socket: Socket) => void): unknown;
}): void {
  server.on("connection", (socket) => {
    if (!allowsClientAddress(socket.remoteAddress)) socket.destroy();
  });
}
