import "server-only";

import { randomBytes, createHash } from "node:crypto";
import type { AuthTokenPurpose } from "@prisma/client";

import { db } from "@/lib/server/db";

/** How long a password-reset link stays valid — short, since it grants
 * account takeover if intercepted (email is not an encrypted channel). */
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
/** Verification links are lower-stakes (they only flip a boolean, they
 * don't let you into the account) — a longer window is fine and more
 * forgiving of someone checking their email a day later. */
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  PASSWORD_RESET: PASSWORD_RESET_TTL_MS,
  EMAIL_VERIFICATION: EMAIL_VERIFICATION_TTL_MS,
};

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Issues a new single-use token for `userId`/`purpose` — returns the RAW
 * token (only this call ever sees it; only its SHA-256 hash is persisted,
 * same "don't store the usable secret" discipline as `User.passwordHash`).
 * The raw token is what gets embedded in the emailed link; nothing in the
 * database can be used to reconstruct it.
 *
 * Invalidates every other still-outstanding, unused token of the SAME
 * purpose for this user first (`deleteMany`, not just marking used — a
 * consumed/expired row has no value to keep around) — so requesting a new
 * password-reset link (e.g. because the first email never arrived) makes
 * the earlier link stop working instead of leaving two simultaneously-valid
 * links for the same account.
 */
export async function createAuthToken(
  userId: string,
  purpose: AuthTokenPurpose
): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[purpose]);

  await db.$transaction([
    db.authToken.deleteMany({ where: { userId, purpose } }),
    db.authToken.create({ data: { userId, purpose, tokenHash, expiresAt } }),
  ]);

  return rawToken;
}

export type ConsumeAuthTokenResult =
  | { valid: true; userId: string }
  | { valid: false; reason: "not-found" | "expired" }
  // `already-used` also carries `userId` (harmless — it's the same value a
  // valid consumption of this token would have revealed) so a caller like
  // `verifyEmail` can check whether that user is ALREADY in the target end
  // state, to tell "this is a stale replay of a link that already worked"
  // apart from "this link never worked" (see verifyEmail's doc comment).
  | { valid: false; reason: "already-used"; userId: string };

/**
 * Validates and consumes a raw token — single-use: a second call with the
 * same token always fails with `"already-used"`, even immediately after a
 * successful first call, so a link can't be replayed (e.g. from an email
 * client's link-prefetching / a browser's back button re-submitting).
 *
 * `"not-found"` covers both "never existed" and "hash doesn't match
 * anything" — deliberately not distinguished from a malformed/tampered
 * token, since there's nothing a caller should do differently either way.
 */
export async function consumeAuthToken(
  rawToken: string,
  purpose: AuthTokenPurpose
): Promise<ConsumeAuthTokenResult> {
  const tokenHash = hashToken(rawToken);
  const record = await db.authToken.findUnique({ where: { tokenHash } });

  if (!record || record.purpose !== purpose) {
    return { valid: false, reason: "not-found" };
  }
  if (record.usedAt) {
    return { valid: false, reason: "already-used", userId: record.userId };
  }
  if (record.expiresAt.getTime() < Date.now()) {
    return { valid: false, reason: "expired" };
  }

  // Mark used FIRST, before the caller does anything with the result — if
  // two requests race on the same valid token, only one `UPDATE` can win
  // this narrowed-by-usedAt-null condition; the loser sees 0 rows affected
  // and is treated as "already used" rather than both proceeding.
  const updated = await db.authToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (updated.count === 0) {
    return { valid: false, reason: "already-used", userId: record.userId };
  }

  return { valid: true, userId: record.userId };
}
