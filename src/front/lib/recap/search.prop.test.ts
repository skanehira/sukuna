import { test, fc } from "@fast-check/vitest";
import { expect } from "vite-plus/test";
import { searchRecap } from "./search";

test.prop([fc.integer({ min: 1, max: 400 })])(
  "本文の一致した行を200件まで残し、残りとの合計は一致件数になる",
  (count) => {
    const body = Array.from({ length: count }, (_, index) => ({
      text: `API ${index}`,
      seq: index + 1,
    }));
    expect(searchRecap({ chapters: [], decisions: [], body }, "api")).toEqual({
      chapters: [],
      decisions: [],
      body: body.slice(0, 200),
      remaining: Math.max(0, count - 200),
    });
  },
);
