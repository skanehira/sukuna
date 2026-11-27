import { execFileSync } from "node:child_process";

export function activeFixtureJob(pid: number): string | null {
  try {
    const row = execFileSync("/bin/ps", ["-p", String(pid), "-o", "state=,lstart=,comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const [state, ...identity] = row.split(/\s+/);
    return !state?.startsWith("Z") && /(?:^|[ /])sleep$/.test(row) ? identity.join(" ") : null;
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1) return null;
    throw error;
  }
}
