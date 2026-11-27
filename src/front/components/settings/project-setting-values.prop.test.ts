import { expect } from "vite-plus/test";
import { fc, test } from "@fast-check/vitest";
import type { ProjectSettings } from "../../../shared/api/project";
import { parseProjectSetting, projectFields } from "./project-setting-values";

const nameArbitrary = fc
  .array(fc.constantFrom("a", "7", "-", "_", "東", "京"), { minLength: 1, maxLength: 40 })
  .map((characters) => characters.join(""));

const editable = fc.record({
  model: fc.constantFrom(null, "opus", "sonnet", "haiku"),
  permissionMode: fc.constantFrom("bypassPermissions", "acceptEdits", "default"),
  autoStages: fc.uniqueArray(fc.constantFrom("triage", "design", "impl")),
  implConcurrency: fc.integer({ min: 1, max: 20 }),
  confirmBeforeMergeDefault: fc.boolean(),
  designMergeMode: fc.constantFrom("direct", "pr"),
  name: nameArbitrary,
  usesGithub: fc.boolean(),
  defaultBranch: nameArbitrary.map((value) => `feature/${value}`),
});

test.prop([editable])("設定の表示を変更せずに保存すると、元と同じ値を送る", (input) => {
  const project: ProjectSettings = {
    ...input,
    id: "fixture",
    path: "/tmp/fixture",
    flowPaused: false,
    globalFlowPaused: false,
    stopTargetCount: 0,
  };
  for (const field of projectFields) {
    if (!field.key) continue;
    expect(parseProjectSetting(field.key, field.value(project))).toEqual({
      [field.key]: input[field.key],
    });
  }
});

test.prop([fc.integer({ min: 21, max: Number.MAX_SAFE_INTEGER })])(
  "同時実行の上限を超える数は、表示用の単位がついていても受け付けない",
  (count) => {
    expect(parseProjectSetting("implConcurrency", `${count} 件まで`)).toBeNull();
  },
);
