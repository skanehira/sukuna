import { createECDH, createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveDirectories, type Directories } from "../../../../shared/env";
import { serviceLabel, type ServiceName } from "../domain/launchd-port";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function writeAtomic(path: string, content: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function buildHash(directory: string): string {
  const hash = createHash("sha256");
  const collect = (root: string, prefix: string) => {
    for (const name of readdirSync(root).sort()) {
      const path = join(root, name);
      const relative = prefix + name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) collect(path, relative + "/");
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        hash.update(JSON.stringify([relative, bytes.length])).update(bytes);
      }
    }
  };
  collect(directory, "");
  return hash.digest("hex");
}

const plistPath = (userHome: string, service: ServiceName) =>
  join(userHome, "Library", "LaunchAgents", serviceLabel(service) + ".plist");

const unescaped: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

export function readInstalledVariables(userHome: string): Record<string, string> {
  const source = readFileSync(plistPath(userHome, "server"), "utf8");
  const variables: Record<string, string> = {};
  for (const [, name, value] of source.matchAll(
    /<key>(XDG_DATA_HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR)<\/key><string>(.*?)<\/string>/g,
  ))
    variables[name!] = value!.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => unescaped[entity]!);
  return variables;
}

export function directoriesForCommand(
  command: string | undefined,
  terminal: Readonly<Record<string, string | undefined>>,
  userHome: string,
): Directories {
  return resolveDirectories(
    command === "update" ? readInstalledVariables(userHome) : terminal,
    userHome,
  );
}

export function createInstallFiles(directories: Directories, userHome: string, repository: string) {
  const agents = join(userHome, "Library", "LaunchAgents");
  const path = (service: ServiceName) => plistPath(userHome, service);
  const hashPath = join(directories.state, "runner-build.sha");
  return {
    prepare() {
      const roots = [directories.data, directories.state, directories.runtime];
      for (const root of roots) {
        mkdirSync(root, { mode: 0o700, recursive: true });
        const relativeUserHome = relative(realpathSync(root), realpathSync(userHome));
        if (
          !isAbsolute(relativeUserHome) &&
          relativeUserHome !== ".." &&
          !relativeUserHome.startsWith(".." + sep)
        ) {
          throw new Error(
            "データの置き場所には、利用者のホームを含まない専用のディレクトリを指定してください。",
          );
        }
      }
      for (const path of [
        ...roots,
        join(directories.data, "images"),
        join(directories.data, "backups"),
        join(directories.state, "logs"),
        join(directories.state, "runner", "recap"),
      ]) {
        mkdirSync(path, { mode: 0o700, recursive: true });
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.uid !== (process.getuid?.() ?? stat.uid))
          throw new Error(`データのディレクトリ ${path} の所有者または種類を確認してください。`);
        try {
          if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
        } catch (error) {
          throw new Error(`データのディレクトリ ${path} の権限を設定できませんでした。`, {
            cause: error,
          });
        }
      }
      mkdirSync(agents, { recursive: true, mode: 0o700 });
      const vapid = join(directories.data, "vapid.json");
      if (!lstatSync(vapid, { throwIfNoEntry: false })) {
        const keys = createECDH("prime256v1");
        keys.generateKeys();
        const scalar = keys.getPrivateKey();
        const privateKey = Buffer.alloc(32);
        scalar.copy(privateKey, privateKey.length - scalar.length);
        try {
          writeFileSync(
            vapid,
            JSON.stringify({
              publicKey: keys.getPublicKey().toString("base64url"),
              privateKey: privateKey.toString("base64url"),
            }),
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      }
    },
    plistPath: path,
    installedPort() {
      const source = readFileSync(path("server"), "utf8");
      const port = Number(/<key>PORT<\/key>\s*<string>(\d+)<\/string>/.exec(source)?.[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new Error("登録されたポートを確認できません。導入のコマンドを実行し直してください。");
      return port;
    },
    writePlist: (service: ServiceName, content: string) => writeAtomic(path(service), content),
    removePlist: (service: ServiceName) => rmSync(path(service), { force: true }),
    runnerHash: async () => buildHash(join(repository, "dist", "runner")),
    writeRunnerHash: (value: string) => writeAtomic(hashPath, value + "\n"),
    readRunnerHash() {
      try {
        return readFileSync(hashPath, "utf8").trim();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}
