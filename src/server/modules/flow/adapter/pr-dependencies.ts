import type { OpenedDatabase } from "../../../../shared/db/open";
import type { GhRunner } from "../../../../shared/gh/gh-runner";
import type { PrDependencies } from "../domain/pr-ports";
import { createPrRepository } from "./pr-repository";
import { createPrGhCli } from "./gh-cli";
import { createPrGitCli } from "../../workspace/adapter/git-cli";
export function createPrDependencies(options: {
  database(): OpenedDatabase["db"];
  gh: GhRunner;
  runner(): PrDependencies["runner"];
  now(): number;
  changed(id: string): void;
}): PrDependencies {
  return {
    get repository() {
      return createPrRepository(options.database());
    },
    transaction: (action) => options.database().transaction((tx) => action(createPrRepository(tx))),
    github: createPrGhCli(options.gh),
    git: createPrGitCli(),
    runner: { forward: (method, path, input) => options.runner().forward(method, path, input) },
    now: () => options.now(),
    publishing: new Set(),
    changed: (id) => options.changed(id),
  };
}
