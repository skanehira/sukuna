import { fc } from "@fast-check/vitest";

if (process.env.STRYKER_MUTATOR_WORKER !== undefined) fc.configureGlobal({ seed: 1 });
