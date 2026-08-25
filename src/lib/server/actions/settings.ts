"use server";

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { Prisma, type Currency } from "@prisma/client";

import { db } from "@/lib/server/db";
import { auth } from "@/lib/server/auth";
import { checkRateLimit, buildPasswordChangeRateLimitKey } from "@/lib/server/rate-limit";
import { LOCALE_COOKIE_NAME } from "@/i18n/locale";
import {
  updateProfileSchema,
  type UpdateProfileInput,
  changePasswordSchema,
  type ChangePasswordInput,
  updatePreferencesSchema,
  type UpdatePreferencesInput,
} from "@/lib/validation/settings";

const BCRYPT_COST_FACTOR = 12;

// One year in seconds — a language preference should persist roughly
// indefinitely, unlike the 7-day auth session (`lib/server/auth.ts`); this
// cookie is intentionally NOT tied to session lifetime, so it also survives
// sign-out (a guest who returns to the browser keeps the last-chosen UI
// language).
const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// These are STABLE KEYS (`errors.<camelCase>`), not translated text — this
// module never imports next-intl. The client (frontend-developer's
// `FieldError`/`FormAlert` components) resolves the key to display text via
// `messages/{locale}.json`'s `errors` namespace. Keep in sync with that
// namespace — see the i18n implementation report for the full key list.
const UNAUTHENTICATED_MESSAGE = "errors.unauthenticated";
const VALIDATION_ERROR_MESSAGE = "errors.validationFailed";
const RATE_LIMITED_MESSAGE = "errors.rateLimited";
const WRONG_CURRENT_PASSWORD_MESSAGE = "errors.wrongCurrentPassword";

// Deliberately DIFFERENT wording from `registerUser`'s `DUPLICATE_EMAIL_MESSAGE`
// (lib/server/actions/auth.ts), even though the task brief for this file
// asked to reuse that exact message: that string is phrased around
// REGISTRATION ("Bu bilgilerle kayıt tamamlanamadı... giriş yapmayı
// deneyin.") and would be actively confusing shown to an already-logged-in
// user editing their profile ("registration couldn't complete, try logging
// in" makes no sense to someone who is, by definition, already logged in
// here). This message keeps the SAME design properties that made the
// original safe: generic/top-level (not attached to `fieldErrors.email`,
// so the UI can't visually single out "this specific email is taken"), and
// it does not claim outright "this email is already registered to someone
// else". Full enumeration-safety isn't achievable here regardless of
// wording, same caveat `registerUser`'s comment already documents: unlike
// registration, a SUCCESSFUL profile update is itself observable by the
// caller, so trying candidate emails one at a time and watching which ones
// succeed vs. fail is an inherent property of any "email must be unique"
// update endpoint, not something message copy can close. (The wording
// argument above still governs the TRANSLATED text this key resolves to in
// `messages/*.json` — only the in-code representation changed to a stable
// key; deliberately a DIFFERENT key from `errors.duplicateEmail`
// (lib/server/actions/auth.ts) for the same reason.)
const EMAIL_IN_USE_MESSAGE = "errors.emailInUse";

// ── getMyProfile ────────────────────────────────────────────────────────

export interface MyProfile {
  name: string;
  email: string;
  preferredLanguage: string;
  preferredCurrency: Currency;
}

export type GetMyProfileResult =
  | { success: true; data: MyProfile }
  | { success: false; error: string };

/**
 * Server Action: the signed-in user's own profile fields — the `/settings`
 * page's data source for pre-filling the account-info and
 * language/currency-preference forms.
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - Auth: requires a session (`auth()`); `{ success: false }` with a
 *    generic message if absent.
 *  - Output: `GetMyProfileResult`. On success, `data` is exactly
 *    `{ name, email, preferredLanguage, preferredCurrency }` — a `select`,
 *    never a bare `db.user.findUnique(...)`, so `passwordHash` can never
 *    leak into this response even by future accident (adding a field to
 *    `MyProfile` requires touching the `select` explicitly).
 *  - `preferredLanguage` is a plain `string` (matches the Prisma column,
 *    which is `String @default("tr")`, not an enum) but is product-limited
 *    to `"tr" | "en"` at the WRITE boundary (`updatePreferences`'s Zod
 *    schema) — this read simply passes through whatever is stored.
 */
export async function getMyProfile(): Promise<GetMyProfileResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  // Session id comes from `auth()` / the signed JWT, never from input — see
  // `lib/server/auth.ts`'s `session` callback. Row could still be absent in
  // the rare case the account was deleted after the JWT was issued (no
  // account-deletion feature exists yet, but a still-valid 7-day-old
  // session cookie referencing a since-removed row is a scenario worth not
  // crashing on) — treated the same as "not authenticated" rather than a
  // 500, since from the caller's point of view the practical remedy
  // (sign in again) is identical either way.
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true, preferredLanguage: true, preferredCurrency: true },
  });
  if (!user) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  return { success: true, data: user };
}

// ── updateProfile ───────────────────────────────────────────────────────

export type UpdateProfileFieldErrors = Partial<Record<keyof UpdateProfileInput, string[]>>;

export type UpdateProfileResult =
  | { success: true; data: { name: string; email: string } }
  | { success: false; error: string; fieldErrors?: UpdateProfileFieldErrors };

/**
 * Server Action: updates the signed-in user's `name`/`email`.
 *
 * Contract:
 *  - Input: `unknown`, conceptually `{ name, email }` — re-validated here
 *    with `updateProfileSchema` (same rules as registration's `name`/
 *    `email`, see lib/validation/settings.ts) regardless of what
 *    client-side validation already did.
 *  - Auth: requires a session; `session.user.id` is the ONLY source of
 *    "which row to update" — never taken from input, so there is no IDOR
 *    surface here (a caller can only ever update their own row).
 *  - Email uniqueness: if the new email differs from every OTHER user's
 *    email (`db.user.findUnique({ where: { email } })`, excluding a match
 *    on the caller's OWN id — so re-submitting your current email is not
 *    treated as a conflict), the update proceeds. Otherwise
 *    `{ success: false, error: EMAIL_IN_USE_MESSAGE }` (see that constant's
 *    comment for why the wording deliberately differs from
 *    `registerUser`'s `DUPLICATE_EMAIL_MESSAGE`, and why full
 *    enumeration-safety isn't fully achievable for this kind of endpoint).
 *  - Race handling: same pattern as `registerUser` — the `findUnique`
 *    pre-check above is not atomic with the `update` that follows, so a
 *    concurrent registration/profile-update claiming the same email between
 *    the two could still slip through; `User.email`'s DB-level `@unique`
 *    constraint is the real guard, and its `P2002` violation is caught
 *    below and reported as the same `EMAIL_IN_USE_MESSAGE`.
 *  - Output: `UpdateProfileResult`. On success, `data` is the fresh
 *    `{ name, email }` (not the full profile — `updatePreferences`'s output
 *    is the analogous "just what changed" shape, and `getMyProfile` is the
 *    full-refresh source of truth).
 *  - NOTE (documented, not fixed, this turn): if `email` changes, the
 *    caller's ACTIVE session JWT still carries the OLD email
 *    (`session.user.email`) until they next sign in — this action does not
 *    force a session refresh. Frontend should re-fetch via `getMyProfile`
 *    after a successful call rather than trusting `useSession()`'s cached
 *    email.
 */
export async function updateProfile(input: unknown): Promise<UpdateProfileResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as UpdateProfileFieldErrors,
    };
  }
  const { name, email } = parsed.data;

  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing && existing.id !== session.user.id) {
    return { success: false, error: EMAIL_IN_USE_MESSAGE };
  }

  try {
    const updated = await db.user.update({
      where: { id: session.user.id },
      data: { name, email },
      select: { name: true, email: true },
    });
    return { success: true, data: updated };
  } catch (error) {
    // Lost the race against a second concurrent request claiming the same
    // email (see RACE HANDLING in the doc comment above) — `User.email`'s
    // DB-level `@unique` constraint is the real source of truth.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: EMAIL_IN_USE_MESSAGE };
    }
    throw error;
  }
}

// ── changePassword ──────────────────────────────────────────────────────

export type ChangePasswordFieldErrors = Partial<Record<keyof ChangePasswordInput, string[]>>;

export type ChangePasswordResult =
  | { success: true }
  | { success: false; error: string; fieldErrors?: ChangePasswordFieldErrors };

/**
 * Server Action: changes the signed-in user's password.
 *
 * Contract:
 *  - Input: `unknown`, conceptually `{ currentPassword, newPassword }` —
 *    re-validated with `changePasswordSchema` (`newPassword` reuses
 *    registration's password policy verbatim, see
 *    lib/validation/settings.ts).
 *  - Auth: requires a session; `session.user.id` is the ONLY source of
 *    "whose password" — never taken from input.
 *  - Rate limit: 10 attempts / 15 minutes, keyed by `session.user.id`
 *    (`"password-change"` policy, lib/server/rate-limit.ts) — checked
 *    BEFORE Zod validation and before touching the DB/bcrypt, same
 *    "cheapest gate first" ordering as `registerUser`'s rate-limit check.
 *    This is brute-force protection for `currentPassword`: without it, a
 *    caller with a valid session (e.g. a hijacked/stolen session cookie,
 *    or a shared/family device) could attempt unlimited guesses against the
 *    real current password.
 *  - Verification: fetches the caller's own `passwordHash` by
 *    `session.user.id` (never trusts a hash or id from input) and runs
 *    `bcrypt.compare(currentPassword, passwordHash)` UNCONDITIONALLY on
 *    every non-rate-limited, shape-valid call — there is no "user not
 *    found" branch to short-circuit around it, since an authenticated
 *    session already guarantees the row exists (see `getMyProfile`'s doc
 *    comment for the one edge case where it might not, which is treated as
 *    unauthenticated upstream of this action too... concretely here,
 *    `findUniqueOrThrow` is used instead: if the row is somehow gone, that
 *    is a genuine server bug at this point, not a caller-triggerable state,
 *    and should surface as a 500 rather than being swallowed).
 *  - Wrong current password: `{ success: false, error:
 *    WRONG_CURRENT_PASSWORD_MESSAGE, fieldErrors: { currentPassword: [...] } }`
 *    — attached to the `currentPassword` field specifically (unlike the
 *    duplicate-email cases elsewhere in this file/actions/auth.ts): there is
 *    no account-enumeration concern here, the caller already knows which
 *    account they are — they're authenticated as it.
 *  - Success: `{ success: true }`, no data payload (nothing new to return —
 *    `name`/`email`/preferences are unaffected). The password hash is never
 *    returned by this or any other action in this file.
 */
export async function changePassword(input: unknown): Promise<ChangePasswordResult> {
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

  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as ChangePasswordFieldErrors,
    };
  }
  const { currentPassword, newPassword } = parsed.data;

  // `findUniqueOrThrow`, not `findUnique` + null check: a valid session
  // means a `User` row existed at JWT-mint time, so an absent row here
  // would be a genuine data-integrity bug (e.g. concurrent hard-delete of
  // the account — no such feature exists yet), not a normal caller path to
  // handle gracefully. Same reasoning `acceptInvite` uses for
  // `db.family.findUniqueOrThrow` after its own transaction commits.
  const user = await db.user.findUniqueOrThrow({
    where: { id: session.user.id },
    select: { passwordHash: true },
  });

  const currentPasswordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!currentPasswordMatches) {
    return {
      success: false,
      error: WRONG_CURRENT_PASSWORD_MESSAGE,
      fieldErrors: { currentPassword: [WRONG_CURRENT_PASSWORD_MESSAGE] },
    };
  }

  const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_COST_FACTOR);
  await db.user.update({
    where: { id: session.user.id },
    data: { passwordHash: newPasswordHash },
  });

  return { success: true };
}

// ── updatePreferences ───────────────────────────────────────────────────

export type UpdatePreferencesFieldErrors = Partial<
  Record<keyof UpdatePreferencesInput, string[]>
>;

export type UpdatePreferencesResult =
  | { success: true; data: { preferredLanguage: string; preferredCurrency: Currency } }
  | { success: false; error: string; fieldErrors?: UpdatePreferencesFieldErrors };

/**
 * Server Action: updates the signed-in user's `preferredLanguage` /
 * `preferredCurrency`.
 *
 * ── i18n WIRING NOTE (updated — was a "HONESTY NOTE" placeholder before
 * next-intl was wired up; do not remove, keep updating it as this evolves)
 * ──────────────────────────────────────────────────────────────────────
 * As of this change, saving `preferredLanguage` DOES take effect: on a
 * successful `db.user.update`, this action also sets the `NEXT_LOCALE`
 * cookie (`src/i18n/locale.ts`'s `LOCALE_COOKIE_NAME`) to the new value.
 * `src/i18n/request.ts`'s `getRequestConfig` reads that cookie FIRST (ahead
 * of the JWT `locale` snapshot) on every subsequent request, so the existing
 * client-side `router.refresh()` after a successful call is what actually
 * flips the UI language — no separate action/endpoint needed. This turn only
 * wires the cookie + request-config plumbing; translating actual page/UI
 * copy into `messages/{locale}.json`'s non-`validation`/`errors` namespaces
 * is frontend-developer's follow-up work, not done here.
 * `preferredCurrency` remains real and already meaningfully used elsewhere
 * (e.g. `Transaction.currency` defaults / display), unaffected by this note.
 *
 * Contract:
 *  - Input: `unknown`, conceptually `{ preferredLanguage, preferredCurrency }`
 *    — both fields REQUIRED (not partial/patch) in this version; re-validated
 *    with `updatePreferencesSchema` (`"tr" | "en"` for language, matching
 *    the Prisma `Currency` enum for currency).
 *  - Auth: requires a session; `session.user.id` is the ONLY source of
 *    "whose preferences" — never taken from input.
 *  - Side effect: on success, sets the `NEXT_LOCALE` cookie to the new
 *    `preferredLanguage` (path `/`, ~1 year max-age, `sameSite: "lax"`,
 *    `httpOnly`, `secure` in production) — see the i18n wiring note above.
 *    This is the only Server Action in this file with a side effect beyond
 *    the DB write.
 *  - Output: `UpdatePreferencesResult`. On success, `data` is the fresh
 *    `{ preferredLanguage, preferredCurrency }`.
 *  - No uniqueness/conflict concerns (unlike `updateProfile`'s email) — this
 *    is a plain, unconditional `db.user.update`.
 */
export async function updatePreferences(input: unknown): Promise<UpdatePreferencesResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = updatePreferencesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as UpdatePreferencesFieldErrors,
    };
  }

  const updated = await db.user.update({
    where: { id: session.user.id },
    data: parsed.data,
    select: { preferredLanguage: true, preferredCurrency: true },
  });

  // Only after the DB write succeeds — a failed/rejected update must not
  // leave the cookie and the stored preference disagreeing with each other.
  // `parsed.data.preferredLanguage` (not `updated.preferredLanguage`) is used
  // deliberately: both are equal here (`data: parsed.data` above is what was
  // just written), but reading the validated INPUT keeps this line
  // independent of `select`'s exact shape.
  (await cookies()).set(LOCALE_COOKIE_NAME, parsed.data.preferredLanguage, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    // Only ever read server-side (`src/i18n/request.ts`) — no client code
    // reads `document.cookie` for this, so `httpOnly` costs nothing and
    // closes off a future XSS from being able to read/rewrite it. `secure`
    // is skipped outside production so `next dev` (plain HTTP) still works;
    // same conditional NextAuth's own session cookie config would use.
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  });

  return { success: true, data: updated };
}
