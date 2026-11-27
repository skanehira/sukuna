type Entry = { path: string; name: string; folder: boolean; children: Map<string, Entry> };
export type TreeRow = { path: string; name: string; folder: boolean; depth: number };
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

export function buildFileTree(paths: string[]): Map<string, Entry> {
  const root = new Map<string, Entry>();
  for (const path of paths) {
    const parts = path.split("/");
    let children = root;
    let parent = "";
    for (const [index, name] of parts.entries()) {
      parent = parent ? `${parent}/${name}` : name;
      let entry = children.get(name);
      if (!entry) {
        entry = { path: parent, name, folder: index < parts.length - 1, children: new Map() };
        children.set(name, entry);
      }
      children = entry.children;
    }
  }
  return root;
}

export function visibleFileTree(
  root: Map<string, Entry>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const append = (entries: Map<string, Entry>, depth: number) => {
    const sorted = [...entries.values()].sort(
      (a, b) => Number(b.folder) - Number(a.folder) || collator.compare(a.name, b.name),
    );
    for (const { path, name, folder, children } of sorted) {
      rows.push({ path, name, folder, depth });
      if (folder && expanded.has(path)) append(children, depth + 1);
    }
  };
  append(root, 0);
  return rows;
}
