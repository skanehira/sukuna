import { fork } from "node:child_process";
import { connect } from "node:net";
import { join } from "node:path";

function runnerSocketIsListening(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    socket.setTimeout(1_000, () =>
      socket.destroy(new Error("ソケットの確認が時間切れになりました。")),
    );
  });
}

export async function launchDevRunner(
  root: string,
  socketPath: string,
  signal: AbortSignal,
  reportError: (message: string) => void,
): Promise<(() => Promise<void>) | undefined> {
  const report = (error: unknown) =>
    reportError("開発用ランナーを起動できませんでした。 " + String(error));
  try {
    if ((await runnerSocketIsListening(socketPath)) || signal.aborted) return;
    const child = fork(join(root, "src", "runner", "dev.mjs"), {
      cwd: root,
      execArgv: [],
      detached: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.on("error", report);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    return async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    };
  } catch (error) {
    report(error);
    return undefined;
  }
}
