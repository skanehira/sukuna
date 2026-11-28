import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createTempHome, removeTempHome } from "../../../../shared/db/test-helpers";
import { launchdPlist } from "../domain/launchd-plist";
import { createInstallFiles, directoriesForCommand, readInstalledVariables } from "./install-files";

it("隔離した導入先に持ち主だけの領域を作り、再導入で VAPID の鍵を維持する", async () => {
  const fixture = createTempHome();
  try {
    const directories = {
      data: join(fixture, "data"),
      state: join(fixture, "state"),
      runtime: join(fixture, "runtime"),
    };
    mkdirSync(directories.data, { mode: 0o755 });
    mkdirSync(join(directories.state, "logs"), { mode: 0o755, recursive: true });
    chmodSync(fixture, 0o755);
    writeFileSync(join(directories.data, "sample.db"), "keep");
    const files = createInstallFiles(directories, fixture, fixture);
    files.prepare();
    const vapid = join(directories.data, "vapid.json");
    const first = readFileSync(vapid, "utf8");
    const keys = JSON.parse(first) as { publicKey: string; privateKey: string };
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(keys.privateKey, "base64url")).toHaveLength(32);
    for (const contained of ["data", "state", "runtime"] as const)
      expect(() =>
        createInstallFiles({ ...directories, [contained]: fixture }, fixture, fixture).prepare(),
      ).toThrow("利用者のホーム");
    expect(statSync(fixture).mode & 0o777).toBe(0o755);
    for (const directory of [
      directories.data,
      join(directories.data, "images"),
      join(directories.data, "backups"),
      directories.state,
      join(directories.state, "logs"),
      join(directories.state, "runner", "recap"),
      directories.runtime,
    ])
      expect([directory, statSync(directory).mode & 0o777]).toEqual([directory, 0o700]);
    expect(readFileSync(join(directories.data, "sample.db"), "utf8")).toBe("keep");
    expect(statSync(vapid).mode & 0o777).toBe(0o600);
    files.writePlist("runner", "plist");
    files.prepare();
    expect(readFileSync(vapid, "utf8")).toBe(first);
    expect(readFileSync(files.plistPath("runner"), "utf8")).toBe("plist");
    const runner = join(fixture, "dist", "runner");
    mkdirSync(runner, { recursive: true });
    writeFileSync(join(runner, "main.js"), "first");
    files.writeRunnerHash(await files.runnerHash());
    expect(readFileSync(join(directories.state, "runner-build.sha"), "utf8")).toBe(
      (await files.runnerHash()) + "\n",
    );
    expect(files.readRunnerHash()).toBe(await files.runnerHash());
    writeFileSync(join(runner, "main.js"), "other");
    expect(files.readRunnerHash()).not.toBe(await files.runnerHash());
  } finally {
    removeTempHome(fixture);
  }
});

it("更新では、登録済みの plist に書いた XDG の環境変数を読む", () => {
  const fixture = createTempHome();
  try {
    const directories = { data: fixture, state: fixture, runtime: fixture };
    const files = createInstallFiles(directories, fixture, fixture);
    mkdirSync(join(fixture, "Library", "LaunchAgents"), { recursive: true });
    files.writePlist(
      "server",
      launchdPlist("server", {
        repository: fixture,
        node: "/bin/node",
        stateDirectory: fixture,
        userHome: fixture,
        port: 4580,
        path: "/bin",
        terminal: {
          XDG_DATA_HOME: "/xdg/a & b",
          XDG_STATE_HOME: "/xdg/state",
          XDG_RUNTIME_DIR: "/xdg/run",
        },
      }),
    );

    expect(readInstalledVariables(fixture)).toEqual({
      XDG_DATA_HOME: "/xdg/a & b",
      XDG_STATE_HOME: "/xdg/state",
      XDG_RUNTIME_DIR: "/xdg/run",
    });
  } finally {
    removeTempHome(fixture);
  }
});

it("update は置き場所を登録済みの plist の値から求め、導入は端末の値から求める", () => {
  const fixture = createTempHome();
  try {
    const files = createInstallFiles(
      { data: fixture, state: fixture, runtime: fixture },
      fixture,
      fixture,
    );
    mkdirSync(join(fixture, "Library", "LaunchAgents"), { recursive: true });
    files.writePlist(
      "server",
      launchdPlist("server", {
        repository: fixture,
        node: "/bin/node",
        stateDirectory: fixture,
        userHome: fixture,
        port: 4580,
        path: "/bin",
        terminal: {
          XDG_DATA_HOME: "/installed/data",
          XDG_STATE_HOME: "/installed/state",
          XDG_RUNTIME_DIR: "/installed/run",
        },
      }),
    );
    const terminal = {
      XDG_DATA_HOME: "/terminal/data",
      XDG_STATE_HOME: "/terminal/state",
      XDG_RUNTIME_DIR: "/terminal/run",
    };

    expect({
      update: directoriesForCommand("update", terminal, fixture),
      install: directoriesForCommand(undefined, terminal, fixture),
    }).toEqual({
      update: {
        data: "/installed/data/sukuna",
        state: "/installed/state/sukuna",
        runtime: "/installed/run/sukuna",
      },
      install: {
        data: "/terminal/data/sukuna",
        state: "/terminal/state/sukuna",
        runtime: "/terminal/run/sukuna",
      },
    });
  } finally {
    removeTempHome(fixture);
  }
});
