import "@testing-library/jest-dom/vitest";

function fakeRects(): DOMRectList {
  const rect = new DOMRect(0, 0, 8, 24);
  return Object.assign([rect], { item: () => rect }) as unknown as DOMRectList;
}

const rangePrototype = Range.prototype as unknown as Record<string, unknown>;
if (typeof rangePrototype.getClientRects !== "function") {
  rangePrototype.getClientRects = fakeRects;
  rangePrototype.getBoundingClientRect = () => new DOMRect(0, 0, 8, 24);
}
