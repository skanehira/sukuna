import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  ftruncateSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";

const maxLogBytes = 100_000_000;

export function rotateLog(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const output = `${path}.1`;
  const temp = `${output}.${process.pid}.tmp`;
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.size <= maxLogBytes) return;
    try {
      copyFileSync(path, temp, constants.COPYFILE_EXCL);
      renameSync(temp, output);
      ftruncateSync(fd, 0);
    } finally {
      rmSync(temp, { force: true });
    }
  } finally {
    closeSync(fd);
  }
}
