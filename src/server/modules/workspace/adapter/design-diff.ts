import type { DesignFile } from "../../../../shared/api/design";

function parseHunks(lines: string[]): DesignFile["hunks"] {
  const hunks: DesignFile["hunks"] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      hunks.push({
        oldStart: oldNo,
        oldLines: Number(header[2] ?? 1),
        newStart: newNo,
        newLines: Number(header[4] ?? 1),
        lines: [],
      });
      continue;
    }
    const hunk = hunks.at(-1);
    if (!hunk) continue;
    const content = line.slice(1);
    if (line.startsWith("+"))
      hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: content });
    if (line.startsWith("-"))
      hunk.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: content });
    if (line.startsWith(" "))
      hunk.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: content });
  }
  return hunks;
}

export function parseDesignDiff(output: string): DesignFile[] | null {
  if (!output) return [];
  const boundary = output.indexOf("\0\0");
  if (boundary < 0) return null;
  const fields = output.slice(0, boundary).split("\0");
  const patches = output
    .slice(boundary + 2)
    .split(/(?:^|(?<=\n))diff --git [^\n]*\n/)
    .slice(1);
  const files: DesignFile[] = [];
  let patchIndex = 0;
  for (let i = 0; i < fields.length;) {
    const marker = /^:[0-7]+ [0-7]+ [0-9a-f]+ [0-9a-f]+ ([ADMRT])\d*$/.exec(fields[i++] ?? "")?.[1];
    if (!marker) return null;
    const firstPath = fields[i++];
    const path = marker === "R" ? fields[i++] : firstPath;
    const patchCount = marker === "T" ? 2 : 1;
    const patchBodies = patches.slice(patchIndex, patchIndex + patchCount);
    if (!path || patchBodies.length !== patchCount) return null;
    patchIndex += patchCount;
    const binary = patchBodies.some((patch) => /^(?:Binary files |GIT binary patch$)/m.test(patch));
    files.push({
      path,
      status:
        marker === "A"
          ? "added"
          : marker === "D"
            ? "deleted"
            : marker === "R"
              ? "renamed"
              : "modified",
      binary,
      hunks: binary ? [] : patchBodies.flatMap((patch) => parseHunks(patch.split("\n"))),
    });
  }
  return patchIndex === patches.length ? files : null;
}
