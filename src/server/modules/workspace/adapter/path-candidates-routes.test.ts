import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { createTempHome, removeTempHome } from "../../../../shared/db/test-helpers";
import { createApp } from "../../../app";
import { incomingWith } from "../../identity/test-support";
import { createProjectDependencies } from "./project-dependencies";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function homeTree() {
  const home = realpathSync(createTempHome());
  cleanups.push(() => removeTempHome(home));
  for (const directory of [
    "src/shop-api/.git",
    "src/shop-notes",
    "src/shop-web",
    "src/wt-feature",
    "src/target",
    ".config",
    "locked",
  ])
    mkdirSync(join(home, directory), { recursive: true });
  writeFileSync(join(home, "src/shop.txt"), "file\n");
  writeFileSync(join(home, "src/wt-feature/.git"), "gitdir: /elsewhere\n");
  writeFileSync(join(home, "notes.txt"), "file\n");
  symlinkSync(join(home, "src/target"), join(home, "src/link-dir"));
  symlinkSync(join(home, "src/shop.txt"), join(home, "src/link-file"));
  symlinkSync(join(home, "src/missing"), join(home, "src/link-broken"));
  return home;
}

type Reader = Parameters<typeof createProjectDependencies>[1]["directories"];
function routes(
  home: string,
  options: { directories?: Reader; wait?: (ms: number) => Promise<void> } = {},
) {
  const app = createApp({
    build: "test",
    projects: createProjectDependencies(
      () => {
        throw new Error("候補の問い合わせはデータベースを開かない");
      },
      {
        runner: () => ({ forward: async () => Response.json({}) }),
        changed: () => {},
        home,
        ...options,
      },
    ),
  });
  return async (query: string) => {
    const response = await app.request(
      `/api/path-candidates${query}`,
      {},
      incomingWith("127.0.0.1", 1234),
    );
    return { status: response.status, body: await response.json() };
  };
}

const found = (candidates: { name: string; text: string; repository: boolean }[]) => ({
  status: 200,
  body: { candidates, truncated: false, note: null },
});
const noted = (note: string) => ({
  status: 200,
  body: { candidates: [], truncated: false, note },
});
const invalid = (message: string) => ({
  status: 400,
  body: { error: { code: "invalid_input", message } },
});

it.each(["", "?text=", "?text=~"])(
  "本文が空か ~ (%s) なら、ホームディレクトリの直下の隠していないディレクトリを返す",
  async (query) => {
    const request = routes(homeTree());
    expect(await request(query)).toEqual(
      found([
        { name: "locked", text: "~/locked/", repository: false },
        { name: "src", text: "~/src/", repository: false },
      ]),
    );
  },
);

it("~/src/sh なら ~/src/ の中の sh で始まるディレクトリを返し、ファイルは出さず、Git のリポジトリに印を付ける", async () => {
  const request = routes(homeTree());
  expect(await request(`?text=${encodeURIComponent("~/src/sh")}`)).toEqual(
    found([
      { name: "shop-api", text: "~/src/shop-api/", repository: true },
      { name: "shop-notes", text: "~/src/shop-notes/", repository: false },
      { name: "shop-web", text: "~/src/shop-web/", repository: false },
    ]),
  );
});

it("/ で始まる本文は、書いたままの探すディレクトリを候補の文に使う", async () => {
  const home = homeTree();
  const request = routes(home);
  expect(await request(`?text=${encodeURIComponent(`${home}/`)}`)).toEqual(
    found([
      { name: "locked", text: `${home}/locked/`, repository: false },
      { name: "src", text: `${home}/src/`, repository: false },
    ]),
  );
});

it("名前の先頭が . なら隠しディレクトリを返す", async () => {
  const request = routes(homeTree());
  expect(await request(`?text=${encodeURIComponent("~/.c")}`)).toEqual(
    found([{ name: ".config", text: "~/.config/", repository: false }]),
  );
});

it("ディレクトリを指すシンボリックリンクだけを返し、ファイルを指すリンクと切れたリンクは出さない", async () => {
  const request = routes(homeTree());
  expect(await request(`?text=${encodeURIComponent("~/src/link-")}`)).toEqual(
    found([{ name: "link-dir", text: "~/src/link-dir/", repository: false }]),
  );
});

it(".git がファイルの worktree には Git のリポジトリの印を付けない", async () => {
  const request = routes(homeTree());
  expect(await request(`?text=${encodeURIComponent("~/src/wt")}`)).toEqual(
    found([{ name: "wt-feature", text: "~/src/wt-feature/", repository: false }]),
  );
});

it.each([
  ["探すディレクトリが無い", "~/nothing/", "ディレクトリがありません: ~/nothing/"],
  [
    "探すディレクトリがディレクトリでない",
    "~/notes.txt/",
    "ディレクトリがありません: ~/notes.txt/",
  ],
  ["一致する名前がない", "~/src/zz", "一致するディレクトリはありません"],
])("%sときは、200 で案内を返す", async (_case, text, note) => {
  const request = routes(homeTree());
  expect(await request(`?text=${encodeURIComponent(text)}`)).toEqual(noted(note));
});

it("読む権限の無いディレクトリは、200 で読めないことを返す", async () => {
  const home = homeTree();
  chmodSync(join(home, "locked"), 0o000);
  cleanups.push(() => chmodSync(join(home, "locked"), 0o755));
  const request = routes(home);
  expect(await request(`?text=${encodeURIComponent("~/locked/")}`)).toEqual(
    noted("ディレクトリを読めません: ~/locked/"),
  );
});

it("一覧を読んだ後の確かめまでを 3 秒で終えられないときは、読めないことを返す", async () => {
  const waits: number[] = [];
  let startStat = () => {};
  const statStarted = new Promise<void>((resolve) => {
    startStat = resolve;
  });
  const request = routes(homeTree(), {
    directories: {
      readdir: (path) => readdir(path, { withFileTypes: true }),
      stat: () => {
        startStat();
        return new Promise(() => {});
      },
    },
    wait: async (ms) => {
      waits.push(ms);
      await statStarted;
    },
  });
  expect({
    response: await request(`?text=${encodeURIComponent("~/src/")}`),
    waits,
  }).toEqual({ response: noted("ディレクトリを読めません: ~/src/"), waits: [3000] });
});

it("本文が探さない形のときは 400 を返す", async () => {
  const request = routes(homeTree());
  expect(await request(`?text=${encodeURIComponent("src/sh")}`)).toEqual(
    invalid("パスは / または ~/ で始まる形で指定してください。"),
  );
});
