import { summarizeUsage, usagePeriod, type UsageRecords } from "../domain/usage";
import type { UsageReport } from "../../../../shared/api/usage";

export type UsageDependencies = {
  now(): number;
  read<T>(from: number, until: number, consume: (records: UsageRecords) => T): T;
};

export function getUsage(deps: UsageDependencies): UsageReport {
  const now = deps.now();
  return deps.read(now - usagePeriod, now, (records) => summarizeUsage(records, now));
}
