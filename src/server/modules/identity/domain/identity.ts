import type { DeniedReason } from "../../../../shared/denied";

export type Identity = {
  login: string;
  device: string;
};

export type IdentityDecision =
  | { allowed: true; identity: Identity }
  | { allowed: false; reason: DeniedReason };

export function normalizeIpv4(address: string): string {
  return address.replace(/^::ffff:/i, "");
}

export function isTailscaleAddress(address: string): boolean {
  const octets = address.split(".");
  if (octets.length !== 4) return false;
  const values = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [first, second] = values;
  return first === 100 && second >= 64 && second <= 127;
}
