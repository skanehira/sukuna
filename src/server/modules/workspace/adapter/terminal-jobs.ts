import { execFile, spawn } from "node:child_process";
import { statSync, type BigIntStats } from "node:fs";
import { constants } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { IPty } from "node-pty";

type Entry = {
  pid: number;
  parent: number;
  group: number;
  state: string;
  started: string;
};

const STOP_TIMEOUT_MS = 3000;
const ps = promisify(execFile);

async function readSession(pty: { pid: number; ptsName?: unknown }): Promise<Entry[]> {
  const tty = "ptsName" in pty ? pty.ptsName : undefined;
  const selector =
    process.platform === "linux"
      ? ["-s", String(pty.pid)]
      : process.platform === "darwin" &&
          typeof tty === "string" &&
          /^\/dev\/ttys[0-9a-z]+$/.test(tty)
        ? ["-t", tty]
        : null;
  if (!selector) throw new Error("端末のプロセスを確認できませんでした。");
  let stdout: string;
  let inspectionPid: number | undefined;
  try {
    const inspection = ps("/bin/ps", [...selector, "-o", "pid=,ppid=,pgid=,state=,lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      timeout: 1000,
    });
    inspectionPid = inspection.child.pid;
    ({ stdout } = await inspection);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return [];
    throw error;
  }
  return stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match || Number(match[1]) === inspectionPid) return [];
      const [, pid, parent, group, state, started] = match;
      return [
        {
          pid: Number(pid),
          parent: Number(parent),
          group: Number(group),
          state: state!,
          started: started!,
        },
      ];
    });
}

function signalOwned(target: number, signal: NodeJS.Signals): boolean {
  if (Math.abs(target) <= 1 || Math.abs(target) === process.pid)
    throw new Error("端末のプロセスを確認できませんでした。");
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export async function stopTerminalJobs(
  pty: Pick<IPty, "pid">,
  isRunning: () => boolean,
): Promise<void> {
  const read = () => readSession(pty);
  const ownsLeader = (entry: Entry) =>
    entry.pid === pty.pid &&
    entry.parent === process.pid &&
    entry.group === pty.pid &&
    !entry.state.startsWith("Z");
  const startDeadline = performance.now() + STOP_TIMEOUT_MS;
  let leader = (await read()).find(ownsLeader);
  while (!leader && isRunning() && performance.now() < startDeadline) {
    await sleep(15);
    leader = (await read()).find(ownsLeader);
  }
  if (!isRunning()) return;
  if (!leader) throw new Error("端末のプロセスを確認できませんでした。");
  const { group, started } = leader;
  const alreadyStopped = leader.state.startsWith("T");
  if (!alreadyStopped && !signalOwned(-group, "SIGSTOP")) return;

  let stopped = false;
  const isSameLeader = (entry: Entry) => ownsLeader(entry) && entry.started === started;
  const stopDeadline = performance.now() + STOP_TIMEOUT_MS;
  try {
    do {
      const session = await read();
      const current = session.find(isSameLeader);
      if (!current) return;
      if (current.state.startsWith("T")) {
        const jobs = new Set(
          session
            .filter((entry) => entry.group !== group && !entry.state.startsWith("Z"))
            .map((entry) => entry.group),
        );
        if (jobs.size === 0) {
          signalOwned(-group, "SIGKILL");
          stopped = true;
          return;
        }
        for (const job of jobs) signalOwned(-job, "SIGKILL");
      }
      await sleep(15);
    } while (performance.now() < stopDeadline);
    throw new Error("端末のプロセスを終了できませんでした。");
  } finally {
    if (!stopped && !alreadyStopped && (await read()).some(isSameLeader))
      signalOwned(-group, "SIGCONT");
  }
}

export function terminalDirectoryKey(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function openedDirectoryMatches(cwd: string, key: string): boolean {
  try {
    const stat = statSync(cwd, { bigint: true });
    return stat.isDirectory() && terminalDirectoryKey(stat) === key;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return false;
    throw error;
  }
}

export async function superviseTerminal(
  shell: string,
  cwd: string,
  directoryKey: string,
): Promise<void> {
  const pid = process.pid;
  const ptsName =
    process.platform === "darwin"
      ? "/dev/" +
        (
          await ps("/bin/ps", ["-p", String(pid), "-o", "tty="], {
            encoding: "utf8",
            timeout: 1000,
          })
        ).stdout.trim()
      : undefined;
  const scope = { pid, ptsName };
  const ownsTerminal = (entry: Entry) => entry.pid === pid && entry.group === pid;
  const owner = (await readSession(scope)).find(ownsTerminal);
  if (!owner || !process.stdin.isTTY) throw new Error("端末の所有を確認できませんでした。");

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    if (!openedDirectoryMatches(cwd, directoryKey)) {
      resolve({ code: null, signal: "SIGKILL" });
      return;
    }
    const child = spawn(shell, ["-l"], {
      cwd,
      stdio: "inherit",
      env: { ...process.env, PWD: cwd },
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => {
      if (!openedDirectoryMatches(cwd, directoryKey)) {
        resolve({ code: null, signal: "SIGKILL" });
        return;
      }
      process.stderr.write("シェルを開けませんでした。設定を確かめてください。\n");
      resolve({ code: 127, signal: null });
    });
  });

  let notified = false;
  const deadline = performance.now() + STOP_TIMEOUT_MS;
  for (;;) {
    try {
      const session = await readSession(scope);
      if (!session.some((entry) => ownsTerminal(entry) && entry.started === owner.started))
        throw new Error("端末の所有を確認できませんでした。");
      const jobs = session.filter((entry) => entry.pid !== pid && !entry.state.startsWith("Z"));
      if (jobs.length === 0) break;
      const targets = new Set(
        jobs.map((entry) => (entry.group === pid ? entry.pid : -entry.group)),
      );
      for (const target of targets) signalOwned(target, "SIGKILL");
      if (performance.now() < deadline) {
        await sleep(15);
        continue;
      }
    } catch {
      if (performance.now() < deadline) {
        await sleep(15);
        continue;
      }
    }
    if (!notified) {
      process.stderr.write("端末に残っているジョブの終了を確認しています。\n");
      notified = true;
    }
    await sleep(500);
  }

  if (signal) {
    process.kill(pid, signal);
    await sleep(100);
    process.exit(128 + constants.signals[signal]);
  }
  process.exit(code ?? 1);
}
