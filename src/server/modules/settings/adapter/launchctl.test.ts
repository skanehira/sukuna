import { expect, it } from "vite-plus/test";
import { createLaunchctl } from "./launchctl";
import { updateApplication } from "../usecase/install";

it("GUIサービスを登録し、登録解除後は元の PID が終わるまで待つ", async () => {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let alive = true;
  let now = 0;
  const launchd = createLaunchctl({
    uid: 501,
    plist: (service) => `/test/dev.sukuna.${service}.plist`,
    run: async (args) => {
      calls.push(args);
      if (args[0] === "print") {
        return args[1]?.endsWith(".restore")
          ? { stdout: "", stderr: "Could not find service", exitCode: 113 }
          : { stdout: "gui/501/dev.sukuna.runner = {\n\tpid = 1345\n}", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    alive: (pid) => pid === 1345 && alive,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
      alive = false;
    },
  });
  expect(await launchd.registered("restore")).toBe(false);
  await launchd.stop("runner");
  expect(sleeps).toEqual([250]);
  await launchd.bootstrap("runner");
  await launchd.kickstart("server", true);
  expect(calls).toEqual([
    ["print", "gui/501/dev.sukuna.restore"],
    ["print", "gui/501/dev.sukuna.runner"],
    ["bootout", "gui/501/dev.sukuna.runner"],
    ["bootstrap", "gui/501", "/test/dev.sukuna.runner.plist"],
    ["kickstart", "-k", "gui/501/dev.sukuna.server"],
  ]);
});

it.each([false, true])(
  "停止確認が失敗したときは実際に外した登録だけを戻す (解除成功=%s)",
  async (bootoutSucceeds) => {
    const calls: string[] = [];
    let now = 0;
    const launchd = createLaunchctl({
      uid: 501,
      plist: (service) => `/test/${service}.plist`,
      now: () => now,
      alive: () => now < 25_250,
      sleep: async (ms) => {
        now += ms;
      },
      run: async (args) => {
        calls.push(args.join(" "));
        switch (args[0]) {
          case "print":
            return { stdout: "\tpid = 1345", stderr: "", exitCode: 0 };
          case "bootout":
            return {
              stdout: "",
              stderr: bootoutSucceeds ? "" : "denied",
              exitCode: bootoutSucceeds ? 0 : 1,
            };
          default:
            return { stdout: "", stderr: "", exitCode: 0 };
        }
      },
    });
    let hash = "old";
    const deps = {
      launchd,
      output: () => {},
      files: {
        prepare() {},
        writePlist() {},
        readRunnerHash: () => hash,
        writeRunnerHash(value: string) {
          hash = value;
        },
        runnerHash: async () => "new",
      },
      ready: async () => [],
    };
    await expect(updateApplication(true, deps)).rejects.toThrow(
      bootoutSucceeds ? "終了を確認" : "bootout",
    );
    expect(hash).toBe("old");
    expect(calls).toEqual([
      "print gui/501/dev.sukuna.runner",
      "bootout gui/501/dev.sukuna.runner",
      ...(bootoutSucceeds ? ["bootstrap gui/501 /test/runner.plist"] : []),
    ]);
    expect(now).toBe(bootoutSucceeds ? 25_250 : 0);
  },
);
