// Framework-agnostic family authorization rules. No Next.js / Prisma imports
// here — this module is shared between the web app (src/lib/server/**) and
// the future mobile client (see barrel comment in lib/domain/index.ts). Same
// pattern as lib/domain/transactions/authorization.ts: plain functions over
// plain data, unit-testable without a database.

/**
 * Pure authorization predicate for "may this user create a new family?".
 * Phase 3.1 rule: a user may belong to at most one family at a time — if
 * they already have a `FamilyMember` row (as owner OR member, in any
 * family), they must leave/be removed from it before creating a new one.
 * `existingMembership` is `null` when the caller's `FamilyMember` lookup
 * found nothing; pass only the minimal shape needed here (an `id` is enough
 * to prove "a row exists") so this stays decoupled from Prisma's generated
 * type.
 */
export function canCreateFamily(existingMembership: { id: string } | null): boolean {
  return existingMembership === null;
}

/**
 * Pure authorization predicate for "may this user accept this family
 * invite?" (Aşama 3.2). Three independent rejection reasons, checked in an
 * order that gives the caller the most useful message first:
 *  1. `already_accepted` — the invite itself was already consumed (its
 *     `acceptedAt` is set), regardless of who consumed it or when.
 *  2. `expired` — `now` is at or past `invite.expiresAt`. Checked after
 *     `already_accepted` so a long-expired-but-also-accepted invite reports
 *     as "already used" rather than "expired" (more accurate: it WAS used,
 *     before it expired).
 *  3. `already_in_family` — same "at most one family" rule as
 *     `canCreateFamily`: the accepting user already has a `FamilyMember` row
 *     in ANY family (including, harmlessly, the one they're trying to join).
 *
 * `now` is a parameter rather than read internally (`Date.now()`) to keep
 * this framework-agnostic and unit-testable without mocking the clock — same
 * reasoning as the rest of this module's docstring.
 */
export function canAcceptInvite(
  invite: { expiresAt: Date; acceptedAt: Date | null },
  existingMembership: { id: string } | null,
  now: Date
): { ok: true } | { ok: false; reason: "expired" | "already_accepted" | "already_in_family" } {
  if (invite.acceptedAt !== null) {
    return { ok: false, reason: "already_accepted" };
  }
  if (now >= invite.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (existingMembership !== null) {
    return { ok: false, reason: "already_in_family" };
  }
  return { ok: true };
}

/**
 * Pure rule for "who becomes the new `OWNER` when the current owner leaves?"
 * (Aşama 3.4 extension — owner leaving used to be blocked outright, now it's
 * allowed and transfers ownership instead). `remainingMembers` must already
 * exclude the leaving owner and be the family's OTHER members; this function
 * doesn't fetch or filter anything itself, it only picks one.
 *
 * Rule: the remaining member with the earliest `joinedAt` — the
 * longest-tenured member is the least arbitrary choice available without
 * asking the leaving owner to pick (out of scope for this phase, same as
 * every other "no explicit ownership-transfer UI yet" boundary in this
 * module). Returns `null` when `remainingMembers` is empty — the caller
 * (`leaveFamily`, lib/server/actions/family.ts) treats that as "solo owner,
 * disband the family" rather than a transfer.
 */
export function selectSuccessorOwner<T extends { joinedAt: Date }>(
  remainingMembers: readonly T[]
): T | null {
  if (remainingMembers.length === 0) return null;
  return remainingMembers.reduce((earliest, candidate) =>
    candidate.joinedAt < earliest.joinedAt ? candidate : earliest
  );
}
