export const WORKTREE_NAME_RULE =
  "名前は 1〜60 字の英数字・.・_・- で、先頭を英数字にしてください。.lock で終わる名前、main、sukuna、design- と issue- で始まる名前は使えません";

export function validWorktreeName(name: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,59}$/.test(name) &&
    !name.endsWith(".lock") &&
    name !== "main" &&
    name !== "sukuna" &&
    !name.startsWith("design-") &&
    !name.startsWith("issue-")
  );
}

export function defaultWorktreeName(
  date: Date,
  worktreeNames: string[],
  branches: string[],
): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const base = `chat-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const occupied = new Set([...worktreeNames, ...branches]);
  let name = base;
  for (let k = 2; occupied.has(name); k += 1) name = `${base}-${k}`;
  return name;
}
