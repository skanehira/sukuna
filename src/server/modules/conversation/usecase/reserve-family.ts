import { err, type Result } from "neverthrow";
import type { LifecycleDependencies, LifecycleError, Reservation } from "../domain/lifecycle";

export async function withFamilyReservations<T>(
  ids: string[],
  onlyIdle: boolean,
  deps: LifecycleDependencies,
  use: (reservations: Reservation[]) => Promise<Result<T, LifecycleError>>,
): Promise<Result<T, LifecycleError>> {
  const reservations: Reservation[] = [];
  try {
    for (const [index, id] of ids.entries()) {
      const current = await deps.reserve(id, index === 0 && onlyIdle);
      if (current.isErr()) return err(current.error);
      reservations.push(current.value);
    }
    return await use(reservations);
  } finally {
    await Promise.all(reservations.map((reservation) => reservation.complete()));
  }
}
