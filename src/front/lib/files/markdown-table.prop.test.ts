import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { fitColumns } from "./markdown-table";

const needs = fc.array(fc.double({ min: 0.5, max: 80, noNaN: true }), {
  minLength: 1,
  maxLength: 8,
});
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

test.prop([needs, fc.double({ min: 1, max: 200, noNaN: true })])(
  "収まらない表は、ちょうど使える幅に収め、どの列も要る幅より広げない",
  (wanted, available) => {
    fc.pre(sum(wanted) > available);
    const fitted = fitColumns(wanted, available);

    expect(sum(fitted)).toBeCloseTo(available, 6);
    fitted.forEach((width, index) => expect(width).toBeLessThanOrEqual(wanted[index] + 1e-9));
  },
);

test.prop([needs, fc.double({ min: 1, max: 200, noNaN: true })])(
  "縮めた列は同じ幅で、縮めなかった列はどれもその幅以下である",
  (wanted, available) => {
    const fitted = fitColumns(wanted, available);
    const shrunk = fitted.filter((width, index) => width < wanted[index] - 1e-9);
    if (shrunk.length === 0) return;
    const share = Math.min(...shrunk);

    shrunk.forEach((width) => expect(width).toBeCloseTo(share, 6));
    wanted.forEach((need, index) => {
      if (fitted[index] >= need - 1e-9) expect(need).toBeLessThanOrEqual(share + 1e-9);
    });
  },
);

test.prop([needs])("収まる表は、要る幅のまま出す", (wanted) => {
  expect(fitColumns(wanted, sum(wanted) + 1)).toEqual(wanted);
});
