import {
  openSync,
  closeSync,
  writeSync,
  writeFileSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { createTempHome, removeTempHome } from "../db/test-helpers";
import { rotateLog } from "./rotate";

it("上限を超えたログだけを一世代前へ写し、開いている出力先は保つ", () => {
  const home = createTempHome();
  const log = join(home, "runner.log");
  writeFileSync(log, "hello");
  writeFileSync(log + ".1", "obsolete");
  const fd = openSync(log, "a");
  try {
    truncateSync(log, 100_000_000);
    rotateLog(log);
    expect(statSync(log).size).toBe(100_000_000);
    expect(readFileSync(log + ".1", "utf8")).toBe("obsolete");
    writeSync(fd, "A");
    rotateLog(log);
    writeSync(fd, "new line");
    expect(readFileSync(log, "utf8")).toBe("new line");
    expect(statSync(log + ".1").size).toBe(100_000_001);
    const snapshot = openSync(log + ".1", "r");
    try {
      const last = Buffer.alloc(1);
      expect(readSync(snapshot, last, 0, 1, 100_000_000)).toBe(1);
      expect(last.toString()).toBe("A");
    } finally {
      closeSync(snapshot);
    }
  } finally {
    closeSync(fd);
    removeTempHome(home);
  }
});
