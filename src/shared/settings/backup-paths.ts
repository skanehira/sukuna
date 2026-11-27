const dailyFile = /^sukuna-(\d{4}-\d{2}-\d{2})\.db$/;
const beforeRestoreFile = /^(before-restore-\d{8}-\d{6})\.db$/;

export function backupFileId(name: string) {
  const daily = dailyFile.exec(name);
  if (daily) return { kind: "daily" as const, id: daily[1]! };
  const before = beforeRestoreFile.exec(name);
  if (before) return { kind: "before_restore" as const, id: before[1]! };
}

export function backupFileName(id: string): string | undefined {
  const name = id.startsWith("before-restore-") ? `${id}.db` : `sukuna-${id}.db`;
  return backupFileId(name) ? name : undefined;
}

const two = (n: number) => String(n).padStart(2, "0");

export function backupDay(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export function beforeRestoreName(date: Date): string {
  return `before-restore-${backupDay(date).replaceAll("-", "")}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}.db`;
}
