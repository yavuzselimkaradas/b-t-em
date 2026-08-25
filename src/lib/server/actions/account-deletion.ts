"use server";

import bcrypt from "bcryptjs";

import { db } from "@/lib/server/db";
import { auth } from "@/lib/server/auth";
import { deleteAccountSchema } from "@/lib/validation/settings";
import {
  buildPasswordChangeRateLimitKey,
  checkRateLimit,
} from "@/lib/server/rate-limit";
import { leaveFamily } from "@/lib/server/actions/family";

// STABLE KEYS (`errors.<camelCase>`) — same i18n discipline as every other
// action file touched this round; this file never imports next-intl. Reuses
// `changePassword`'s exact keys where the underlying check is the same one
// (wrong password / rate-limited / unauthenticated / malformed input).
const UNAUTHENTICATED_MESSAGE = "errors.unauthenticated";
const VALIDATION_ERROR_MESSAGE = "errors.validationFailed";
const RATE_LIMITED_MESSAGE = "errors.rateLimited";
const WRONG_CURRENT_PASSWORD_MESSAGE = "errors.wrongCurrentPassword";

export type DeleteAccountFieldErrors = Partial<Record<"password", string[]>>;

export type DeleteAccountResult =
  | { success: true }
  | { success: false; error: string; fieldErrors?: DeleteAccountFieldErrors };

/**
 * Server Action: PERMANENTLY deletes the signed-in user's account and every
 * row that belongs to them — this is the most destructive action in the
 * codebase (nothing else, including any family-plan action, discards data
 * this broadly or this irreversibly), so it requires re-entering the
 * current password (same `bcrypt.compare` + rate-limit shape as
 * `changePassword`) as a deliberate extra confirmation step beyond "clicked
 * a dialog button" — a briefly-unlocked device or a stale open tab
 * shouldn't be enough on its own to destroy an account.
 *
 * ── WHY THIS ISN'T A SINGLE `db.user.delete()` ───────────────────────────
 * Several of `User`'s relations are `ON DELETE RESTRICT` at the DB level
 * (`Transaction.userId`/`createdById`, `RecurringTransaction.userId`/
 * `createdById`, `Family.ownerId`, `FamilyInvite.invitedBy` — see
 * prisma/schema.prisma) precisely so a plain delete FAILS LOUDLY instead of
 * silently orphaning another user's data — a family member's transaction
 * history must never vanish or corrupt just because a DIFFERENT member's
 * account is deleted. `Budget.userId` is `ON DELETE SET NULL`, which would
 * otherwise leave a `familyId: null, userId: null` budget row violating the
 * `budget_owner_xor` CHECK constraint (see prisma/README.md) — so personal
 * budgets are deleted explicitly here too, not left to that default.
 * `Category`/`FamilyMember`/`AuthToken` all cascade automatically and need
 * no manual handling.
 *
 * Order of operations:
 *  1. If the user currently owns or belongs to a family, `leaveFamily()`
 *     runs FIRST (reused verbatim, not reimplemented) — it already contains
 *     the correct owner-succession / solo-owner-disband logic (see its own
 *     doc comment, lib/server/actions/family.ts). Its `NOT_IN_FAMILY`
 *     failure is expected/harmless here (nothing to leave) and is the only
 *     failure this step tolerates; any other failure aborts the whole
 *     deletion rather than proceeding with a family relationship still
 *     dangling.
 *  2. Every row this user's OWN id is the required, non-nullable owner of
 *     (`FamilyInvite.invitedBy`, `Transaction`, `RecurringTransaction`,
 *     `Budget`) is deleted in one `$transaction` alongside the `User` row
 *     itself, so this step is all-or-nothing — a mid-sequence failure never
 *     leaves a half-deleted account.
 *  3. The session is destroyed (`signOut`) by the caller after this
 *     resolves `{ success: true }` — done client-side (see
 *     `DeleteAccountDialog`), not here, since a Server Action can set
 *     cookies but redirecting the browser away is a client-navigation
 *     concern.
 *
 * `userId`/`createdById` on `Transaction`/`RecurringTransaction` are ALWAYS
 * equal for every row this codebase creates today (`createTransaction`'s
 * own doc comment: "Aşama 3.3 explicitly does NOT support 'owner adds a
 * transaction on behalf of another member' yet") — so deleting by `userId`
 * alone is exhaustive; there is no row where this user is `createdById` but
 * a DIFFERENT user is `userId` that would need separate handling.
 */
export async function deleteMyAccount(input: unknown): Promise<DeleteAccountResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const { allowed } = await checkRateLimit(
    buildPasswordChangeRateLimitKey(session.user.id),
    "password-change"
  );
  if (!allowed) {
    return { success: false, error: RATE_LIMITED_MESSAGE };
  }

  const parsed = deleteAccountSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as DeleteAccountFieldErrors,
    };
  }

  const user = await db.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { passwordHash: true },
  });

  const passwordMatches = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!passwordMatches) {
    return {
      success: false,
      error: WRONG_CURRENT_PASSWORD_MESSAGE,
      fieldErrors: { password: [WRONG_CURRENT_PASSWORD_MESSAGE] },
    };
  }

  const familyResult = await leaveFamily();
  if (!familyResult.success && familyResult.error !== "Bir aile planında değilsiniz.") {
    // A real failure (not just "nothing to leave") — abort rather than
    // proceed with a family relationship still pointing at an account
    // that's about to disappear.
    return { success: false, error: VALIDATION_ERROR_MESSAGE };
  }

  const userId = session.user.id;
  await db.$transaction([
    db.familyInvite.deleteMany({ where: { invitedBy: userId } }),
    db.transaction.deleteMany({ where: { userId } }),
    db.recurringTransaction.deleteMany({ where: { userId } }),
    db.budget.deleteMany({ where: { userId } }),
    db.user.delete({ where: { id: userId } }),
  ]);

  return { success: true };
}
