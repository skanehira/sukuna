import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { physicalFile } from "./git-registration";
import { acquireRecordedGitLock, type RecordedGitLock } from "./recorded-lock";

it("公開先へリンクする前に実物の識別子を記録し、既存の外部ロックは保持する", () => {
  const directory = mkdtempSync(join(tmpdir(), "sukuna-lock-test-"));
  const path = join(directory, "HEAD.lock");
  try {
    let planned: RecordedGitLock | undefined;
    let released: RecordedGitLock | undefined;
    const acquired = acquireRecordedGitLock(path, {
      planned(file) {
        expect(physicalFile(path)).toBeNull();
        expect(physicalFile(file.stagedPath!)).toBe(file.key);
        planned = file;
      },
      released(file) {
        released = file;
      },
    });
    expect(planned).toEqual(acquired.file);
    expect(physicalFile(path)).toBe(acquired.file.key);
    acquired.release();
    expect(released).toEqual(planned);
    expect(physicalFile(path)).toBeNull();

    writeFileSync(path, "foreign");
    const foreign = physicalFile(path);
    expect(() => acquireRecordedGitLock(path, { planned() {}, released() {} })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("foreign");
    expect(physicalFile(path)).toBe(foreign);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
