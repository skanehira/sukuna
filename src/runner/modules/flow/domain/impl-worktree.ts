export function implementationWorktreeName(
  number: number,
  names: readonly string[],
  branches: readonly string[],
) {
  for (let ordinal = 1; ; ordinal++) {
    const name = ordinal === 1 ? `issue-${number}` : `issue-${number}-${ordinal}`;
    const branch = `sukuna/${name}`;
    if (!names.includes(name) && !branches.includes(branch)) return { name, branch };
  }
}

export function nextPortSlot(slots: readonly (number | null)[]) {
  const occupied = new Set(slots);
  let slot = 0;
  while (occupied.has(slot)) slot++;
  return slot;
}

export function reusableImplementationTree<T extends { createdAt: number }>(
  trees: readonly T[],
  after: number,
): T | undefined {
  return trees.reduce<T | undefined>(
    (newest, tree) =>
      tree.createdAt > after && (!newest || tree.createdAt > newest.createdAt) ? tree : newest,
    undefined,
  );
}
