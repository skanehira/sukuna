import { expect, it } from "vite-plus/test";
import {
  implementationWorktreeName,
  nextPortSlot,
  reusableImplementationTree,
} from "./impl-worktree";

it("名前とブランチのどちらかが使用されていれば空いている最小の接尾辞へ進む", () => {
  expect(implementationWorktreeName(42, ["issue-42"], ["sukuna/issue-42-2"])).toEqual({
    name: "issue-42-3",
    branch: "sukuna/issue-42-3",
  });
  expect(nextPortSlot([0, 2, null])).toBe(1);
});

it("最後に完了または直しに戻した後の未片付けの実装作業場所だけを使い直す", () => {
  const old = { id: "old", branch: "sukuna/issue-42", path: "/work/issue-42", createdAt: 10 };
  const current = {
    id: "new",
    branch: "sukuna/issue-42-2",
    path: "/work/issue-42-2",
    createdAt: 20,
  };
  expect(reusableImplementationTree([old, current], 10)).toEqual(current);
  expect(reusableImplementationTree([old, current], 20)).toBeUndefined();
});
