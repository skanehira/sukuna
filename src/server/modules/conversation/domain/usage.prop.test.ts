import { fc, test } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { perTurnCost } from "./usage";

const charge = fc.integer({ min: 1, max: 1_000_000 });

test.prop([charge, charge])(
  "累計に足された番の料金は以前の料金にかかわらず同じになる",
  (previous, turn) => {
    expect(perTurnCost(previous + turn, previous)).toBe(turn);
  },
);

test.prop([charge, charge])(
  "累計がリセットされた後は最初の番の料金を数える",
  (turn, beforeReset) => {
    expect(perTurnCost(turn, turn + beforeReset)).toBe(turn);
  },
);
