import {
  projectPatchSchema,
  type ProjectPatch,
  type ProjectSettings,
} from "../../../shared/api/project";

const permission = {
  bypassPermissions: "確認しない",
  acceptEdits: "編集だけ確認しない",
  default: "毎回確認する",
} as const;
const stages = { triage: "精査", design: "設計", impl: "実装" } as const;
const enabled = { true: "使う", false: "使わない" } as const;
const permissionText = (mode: ProjectSettings["permissionMode"]) => `${permission[mode]} (${mode})`;

const modes: ProjectSettings["permissionMode"][] = ["bypassPermissions", "acceptEdits", "default"];

function readPermission(text: string) {
  return (
    projectPatchSchema.shape.permissionMode.safeParse(text).data ??
    modes.find((mode) => permissionText(mode) === text)
  );
}

function readStages(text: string) {
  if (text === "なし") return [];
  return text.split("/").map((part) => {
    const label = part.trim();
    return Object.entries(stages).find(([, name]) => name === label)?.[0];
  });
}

export function parseProjectSetting(key: EditableProjectSetting, raw: string): ProjectPatch | null {
  const text = raw.trim();
  let value: unknown;
  switch (key) {
    case "model":
      value = text === "" || text === "Claude Code の既定" ? null : text;
      break;
    case "permissionMode":
      value = readPermission(text);
      break;
    case "autoStages":
      value = readStages(text);
      break;
    case "implConcurrency": {
      const count = /^(\d+)(?:\s*件まで)?$/.exec(text)?.[1];
      value = count === undefined ? undefined : Number(count);
      break;
    }
    case "confirmBeforeMergeDefault":
      value = { 自動: false, 確認する: true }[text as "自動" | "確認する"];
      break;
    case "designMergeMode":
      value = { 直接: "direct", PR: "pr" }[text as "直接" | "PR"];
      break;
    case "name":
      value = Array.from(raw).length <= 40 && /^[^\s/\p{Cc}]+$/u.test(raw) ? raw : undefined;
      break;
    case "usesGithub":
      value = { 使う: true, 使わない: false }[text as "使う" | "使わない"];
      break;
    case "defaultBranch":
      value = /^[^\s\p{Cc}]+$/u.test(raw) ? raw : undefined;
      break;
  }
  if (value === undefined) return null;
  return projectPatchSchema.safeParse({ [key]: value }).data ?? null;
}

export type EditableProjectSetting = Exclude<keyof ProjectPatch, "flowPaused">;

type Field = {
  key?: EditableProjectSetting;
  label: string;
  value: (project: ProjectSettings) => string;
  allowed?: string;
};

export const projectFields: readonly Field[] = [
  {
    key: "model",
    label: "モデル",
    value: (project) => project.model ?? "Claude Code の既定",
    allowed: "opus / sonnet / haiku / 空 (Claude Code の既定)",
  },
  {
    key: "permissionMode",
    label: "許可の扱い",
    value: (project) => permissionText(project.permissionMode),
    allowed: modes.map(permissionText).join(" / "),
  },
  {
    key: "autoStages",
    label: "自動で処理する段階",
    value: (project) => project.autoStages.map((stage) => stages[stage]).join(" / ") || "なし",
    allowed: "精査・設計・実装を / で区切るか、なし",
  },
  {
    key: "implConcurrency",
    label: "実装の同時実行",
    value: (project) => `${project.implConcurrency} 件まで`,
    allowed: "1〜20 の整数",
  },
  {
    key: "confirmBeforeMergeDefault",
    label: "merge",
    value: (project) => (project.confirmBeforeMergeDefault ? "確認する" : "自動"),
    allowed: "自動 / 確認する",
  },
  {
    key: "designMergeMode",
    label: "設計書の反映のしかた",
    value: (project) => (project.designMergeMode === "direct" ? "直接" : "PR"),
    allowed: "直接 / PR",
  },
  {
    label: "このプロジェクトの自動フロー",
    value: (project) => (project.flowPaused ? "停止中" : "動作中"),
  },
  {
    key: "name",
    label: "名前",
    value: (project) => project.name,
    allowed: "空白と / を含まない 1〜40 字",
  },
  { label: "パス", value: (project) => project.path },
  {
    key: "usesGithub",
    label: "GitHub を使う",
    value: (project) => enabled[project.usesGithub ? "true" : "false"],
    allowed: "使う / 使わない",
  },
  {
    key: "defaultBranch",
    label: "既定ブランチ",
    value: (project) => project.defaultBranch,
    allowed: "手元のブランチ名 (GitHub を使うときは origin のブランチ名も可)",
  },
];
