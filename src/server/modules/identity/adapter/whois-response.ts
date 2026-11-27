import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { WhoisFailure, WhoisOwner } from "../domain/ports";

const whoisResponseSchema = z.object({
  UserProfile: z.object({ LoginName: z.string() }),
  Node: z.object({
    ComputedName: z.string().optional(),
    Name: z.string().optional(),
  }),
});

export function parseWhoisResponse(status: number, body: string): Result<WhoisOwner, WhoisFailure> {
  if (status === 401 || status === 403) {
    return err("auth");
  }
  if (status === 404) {
    return err("not_found");
  }
  if (status !== 200) {
    return err("invalid_response");
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return err("invalid_response");
  }
  const parsed = whoisResponseSchema.safeParse(json);
  if (!parsed.success) {
    return err("invalid_response");
  }
  const deviceName = parsed.data.Node.ComputedName ?? parsed.data.Node.Name;
  if (deviceName === undefined) {
    return err("invalid_response");
  }
  return ok({ loginName: parsed.data.UserProfile.LoginName, deviceName });
}
