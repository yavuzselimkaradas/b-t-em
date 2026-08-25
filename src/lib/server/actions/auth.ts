"use server";

import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/server/db";
import { registerSchema, type RegisterInput } from "@/lib/validation/auth";
import { buildRegisterRateLimitKey, checkRateLimit, getClientIp } from "@/lib/server/rate-limit";
import { sendVerificationEmailFor } from "@/lib/server/actions/email-verification";

const BCRYPT_COST_FACTOR = 12;

// Deliberately generic and NOT attached to the `email` field: this app
// creates the account immediately at registration (no email-verification /
// magic-link step to hide behind), so a duplicate-email response can't be
// made fully signal-free — but we still avoid confirming "this email exists"
// as a fact, and avoid highlighting the email field specifically, so a
// registration attempt doesn't become a targeted account-enumeration oracle.
// (The wording argument above governs the TRANSLATED text this key resolves
// to in `messages/*.json` — this module never imports next-intl, it only
// returns the stable key; see `errors.duplicateEmail` there. Deliberately a
// DIFFERENT key from `errors.emailInUse`, lib/server/actions/settings.ts,
// for the reasons that constant's own comment documents.)
const DUPLICATE_EMAIL_MESSAGE = "errors.duplicateEmail";

// Same key as `lib/server/actions/settings.ts`'s `RATE_LIMITED_MESSAGE` — the
// underlying Turkish text is identical, so this deliberately dedupes to one
// shared `errors.*` key rather than minting a second one for the same
// message (see this file's task brief: "aynı Türkçe cümle... AYNI key").
const RATE_LIMITED_MESSAGE = "errors.rateLimited";

export type RegisterFieldErrors = Partial<Record<keyof RegisterInput, string[]>>;

export type RegisterResult =
  | { success: true; userId: string }
  | { success: false; error: string; fieldErrors?: RegisterFieldErrors };

/**
 * Server Action: creates a new User account.
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - Input: a plain object shaped like `RegisterInput` ({ name, email, password }).
 *    Treated as fully untrusted regardless of what the client-side form
 *    validation already did — re-validated here with the same Zod schema
 *    (`registerSchema` from "@/lib/validation/auth").
 *  - Output: `RegisterResult`. On success, `{ success: true, userId }` — no
 *    session is created here and the password hash is never returned. This
 *    action only creates the account; call NextAuth's `signIn("credentials",
 *    { email, password, redirect: false })` client-side afterwards to log
 *    the new user in.
 *  - On validation failure: `{ success: false, error, fieldErrors }` where
 *    `fieldErrors` mirrors Zod's `flatten().fieldErrors` shape, keyed by
 *    `name` | `email` | `password`.
 *  - On duplicate email (including a race between two concurrent
 *    registrations for the same address): `{ success: false, error }` with a
 *    generic, top-level message (no `fieldErrors.email`) that doesn't
 *    confirm the email is registered — display it as a general form banner,
 *    not attached to the email input, so registration can't be used to
 *    enumerate existing accounts.
 *
 * There is no authorization check here beyond the input validation itself:
 * registration is intentionally open to any caller (that's the point of a
 * signup endpoint). Every other Server Action in this codebase must check
 * `auth()` / ownership; this one is the deliberate exception.
 *
 * Rate-limited to 5 new accounts / hour per IP (see
 * "@/lib/server/rate-limit") — checked first, before Zod validation, since
 * it's the cheapest possible gate and should reject over-budget callers
 * before any other work runs. `{ success: false, error }` with a generic
 * "too many attempts" message on that path.
 */
export async function registerUser(input: unknown): Promise<RegisterResult> {
  const ip = getClientIp(await headers());
  const { allowed } = await checkRateLimit(buildRegisterRateLimitKey(ip), "register");
  if (!allowed) {
    return { success: false, error: RATE_LIMITED_MESSAGE };
  }

  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      // Same key as every other "shape validation failed" response in this
      // codebase (`errors.validationFailed`) — see `RATE_LIMITED_MESSAGE`'s
      // comment above for the dedup rationale.
      error: "errors.validationFailed",
      fieldErrors: parsed.error.flatten().fieldErrors as RegisterFieldErrors,
    };
  }

  const { name, email, password } = parsed.data;

  const existing = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    return { success: false, error: DUPLICATE_EMAIL_MESSAGE };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST_FACTOR);

  try {
    const user = await db.user.create({
      data: {
        name,
        email,
        passwordHash,
        // preferredLanguage / preferredCurrency use the schema defaults
        // ("tr" / TRY) — no need to set them explicitly here.
      },
      select: { id: true },
    });

    // Fire-and-forget: never throws (see its own doc comment), so a failed
    // email send can't fail the registration that already succeeded. Not
    // awaited-and-checked here on purpose — the caller (RegisterForm)
    // proceeds straight to auto-sign-in either way; the account being
    // unverified is surfaced later via `EmailVerificationBanner`, not as a
    // registration-time error.
    void sendVerificationEmailFor({ id: user.id, email, name });

    return { success: true, userId: user.id };
  } catch (error) {
    // Guard against the race where two requests for the same email pass the
    // findUnique check above concurrently — the DB's unique constraint on
    // User.email is the real source of truth, this is just a friendly
    // message on top of it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: DUPLICATE_EMAIL_MESSAGE };
    }
    throw error;
  }
}
