import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { designResponseSchema } from "../../../../shared/api/design";
import { openMigratedDatabase } from "../../../../shared/db/test-helpers";
import { createApp } from "../../../app";
import { incomingWith } from "../../identity/test-support";
import { createProjectDependencies } from "../../workspace/adapter/project-dependencies";
import { designFixture, git } from "../design-test-support";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("設計の反映とプロジェクトの解除", () => {
  const f = designFixture();
  const approve = (headCommit: string) =>
    f.request("/api/issues/issue/design/approve", "POST", { headCommit });

  function projectRequests(beforeStop?: () => Promise<void>) {
    const database = openMigratedDatabase(f.home);
    const app = createApp({
      build: "test",
      projects: createProjectDependencies(() => database, {
        home: f.home,
        gh: f.runner.gh,
        changed: () => {},
        runner: () => ({
          async forward(method, path, input) {
            if (path === "/flow/projects/project/stop") await beforeStop?.();
            return f.link.forward(method, path, input);
          },
        }),
      }),
    });
    return {
      remove: () =>
        app.request("/api/projects/project", { method: "DELETE" }, incomingWith("127.0.0.1", 5000)),
      restore: () =>
        app.request(
          "/api/projects",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: f.repository }),
          },
          incomingWith("127.0.0.1", 5000),
        ),
      close: () => database.close(),
    };
  }

  it.each(["手元へ直接", "リモートへ直接", "変更なし", "PR", "反映の失敗"] as const)(
    "%s の結果が確定するまで登録を解除できず、確定した後は解除と再登録ができる",
    async (mode) => {
      if (mode === "リモートへ直接" || mode === "PR")
        f.options({ usesGithub: true, designMergeMode: mode === "PR" ? "pr" : "direct" });
      const tree = await f.prepare(mode !== "変更なし");
      if (mode === "反映の失敗") {
        writeFileSync(join(f.repository, "design.md"), "first\nconflicting main\nlast\n");
        git(f.repository, "add", "design.md");
        git(f.repository, "commit", "-qm", "main changes the same line");
      }
      const mainPath = mode === "リモートへ直接" ? f.remote : f.repository;
      const before = git(mainPath, "rev-parse", "main");
      const entered = deferred();
      const reflect = deferred();
      let paused = false;
      f.interceptGit(async () => {
        if (paused || !f.events().some(({ type }) => type === "design_approved")) return;
        paused = true;
        entered.resolve();
        await reflect.promise;
      });
      const project = projectRequests();
      try {
        expect((await approve(tree.head)).status).toBe(202);
        await Promise.race([
          entered.promise,
          f.runner.design.drain().then(() => {
            throw new Error("設計反映が Git の処理を待たずに終了しました。");
          }),
        ]);
        f.advanceToDeadline();
        const during = await project.remove();
        expect(during.status).toBe(409);
        expect(await during.json()).toMatchObject({ error: { code: "conflict" } });
        expect(f.state()).toBe("design_review");
        expect(git(mainPath, "rev-parse", "main")).toBe(before);
        expect(f.ghCalls()).toEqual(
          mode === "PR"
            ? [
                {
                  args: ["repo", "view", "--json", "nameWithOwner,url", "--", f.remote],
                  cwd: f.repository,
                },
              ]
            : [],
        );

        reflect.resolve();
        await f.runner.design.drain();
        let expectedStatus = "approved";
        let outcome = "design_reflected";
        if (mode === "PR") {
          expectedStatus = "merging_pr";
          outcome = "design_pr_created";
          expect(f.ghCalls().map(({ args }) => args.slice(0, 2))).toEqual([
            ["repo", "view"],
            ["repo", "view"],
            ["pr", "create"],
            ["pr", "view"],
          ]);
          expect(f.runner.runtime.store.events("design")).toContainEqual(
            expect.objectContaining({
              type: "user_message",
              payload: expect.objectContaining({
                origin: "flow",
                text: expect.stringContaining(
                  "設計書の PR https://github.com/example/design/pull/1",
                ),
              }),
            }),
          );
        }
        if (mode === "反映の失敗") {
          expectedStatus = "reviewing";
          outcome = "design_reflect_failed";
        }
        expect(f.events().filter(({ type }) => type === outcome)).toHaveLength(1);
        expect(git(mainPath, "rev-parse", "main")).toBe(
          mode === "手元へ直接" || mode === "リモートへ直接" ? tree.head : before,
        );
        expect((await project.remove()).status).toBe(200);
        expect((await f.request()).status).toBe(404);
        expect((await project.restore()).status).toBe(200);
        const restored = designResponseSchema.parse(await (await f.request()).json());
        expect(restored.status).toBe(expectedStatus);
        if (mode === "反映の失敗") expect(restored.reflection.failure).toBeTruthy();
      } finally {
        reflect.resolve();
        await f.runner.design.drain();
        project.close();
      }
    },
  );

  it("先に登録解除を始めた場合は、承認の履歴を残さず失敗する", async () => {
    const tree = await f.prepare();
    const before = git(f.repository, "rev-parse", "main");
    const events = f.events();
    const entered = deferred();
    const remove = deferred();
    const project = projectRequests(async () => {
      entered.resolve();
      await remove.promise;
    });
    const removing = Promise.resolve(project.remove());
    try {
      await Promise.race([
        entered.promise,
        removing.then((response) => {
          throw new Error(`会話を止める前に HTTP ${response.status} を返しました。`);
        }),
      ]);
      const denied = await approve(tree.head);
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ error: { code: "conflict" } });
      expect(f.events()).toEqual(events);
      expect(git(f.repository, "rev-parse", "main")).toBe(before);
      expect(f.ghCalls()).toEqual([]);
      remove.resolve();
      expect((await removing).status).toBe(200);
      expect((await project.restore()).status).toBe(200);
      expect((await approve(tree.head)).status).toBe(202);
      await f.runner.design.drain();
      expect(f.state()).toBe("ready");
    } finally {
      remove.resolve();
      await removing;
      await f.runner.design.drain();
      project.close();
    }
  });

  it("承認を記録する前に期限が切れた場合も、登録解除できる", async () => {
    const tree = await f.prepare();
    const before = git(f.repository, "rev-parse", "main");
    const events = f.events();
    const project = projectRequests();
    try {
      f.expireAfterInsert("issue_events", "design_approved");
      const expired = await approve(tree.head);
      expect(expired.status).toBe(503);
      expect(await expired.json()).toMatchObject({ error: { code: "runner_unavailable" } });
      expect(f.events()).toEqual(events);
      expect(git(f.repository, "rev-parse", "main")).toBe(before);
      expect((await project.remove()).status).toBe(200);
    } finally {
      await f.runner.design.drain();
      project.close();
    }
  });
});
