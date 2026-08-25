"use server";

import { headers } from "next/headers";
import bcrypt from "bcryptjs";

import { db } from "@/lib/server/db";
import {
  requestPasswordResetSchema,
  resetPasswordSchema,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
} from "@/lib/validation/auth";
import {
  buildPasswordResetRequestRateLimitKey,
  checkRateLimit,
  getClientIp,
} from "@/lib/server/rate-limit";
import { createAuthToken, consumeAuthToken } from "@/lib/server/auth-tokens";
import { sendEmail } from "@/lib/server/email/send";
import { resolveAppUrl, escapeHtml } from "@/lib/server/email/helpers";

const BCRYPT_COST_FACTOR = 12;

// STABLE KEYS (`errors.<camelCase>`), not translated text — see
// lib/server/actions/settings.ts's identical i18n note. This file never
// imports next-intl.
const RATE_LIMITED_MESSAGE = "errors.rateLimited";
const VALIDATION_ERROR_MESSAGE = "errors.validationFailed";
const TOKEN_INVALID_MESSAGE = "errors.resetTokenInvalid";

export type RequestPasswordResetResult =
  | { success: true }
  | { success: false; error: string };

/**
 * Server Action: sends a password-reset email if `email` belongs to a real
 * account — but resolves the SAME generic `{ success: true }` regardless of
 * whether it does. This is the account-enumeration defense: a "no account
 * with that email" response would let a caller test arbitrary addresses
 * against this endpoint and learn who has a Bütçem account, same reasoning
 * as `registerUser`'s `DUPLICATE_EMAIL_MESSAGE` and `authorize()`'s
 * constant-time dummy-hash compare (lib/server/auth.ts) — this is the third
 * instance of the same principle in this codebase, applied to the one
 * remaining place it hadn't been yet.
 *
 * Rate-limited by email+IP (5 / 15min, see rate-limit.ts) BEFORE the DB
 * lookup — both to bound how many emails a caller can force out for one
 * address, and as the cheapest possible reject for a spam/abuse loop.
 *
 * `sendEmail` never throws (see its own doc comment) — a failed send still
 * resolves `{ success: true }` here, deliberately: surfacing "the email
 * failed to send" would itself leak whether the account exists (a
 * nonexistent email never reaches `sendEmail` at all, so its failure mode
 * would differ observably from a real address whose provider rejected the
 * message). The one failure mode this can't hide is total silence — if
 * RESEND_API_KEY is unset, the "email" only reaches the server console (see
 * send.ts); that's a deployment misconfiguration, not a response the caller
 * can distinguish from a real send.
 */
export async function requestPasswordReset(
  input: unknown
): Promise<RequestPasswordResetResult> {
  const parsed = requestPasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    // Shape errors (not a valid email at all) are still worth telling the
    // caller about — this isn't an enumeration risk, malformed input reveals
    // nothing about any account.
    return { success: false, error: VALIDATION_ERROR_MESSAGE };
  }
  const { email }: RequestPasswordResetInput = parsed.data;

  const ip = getClientIp(await headers());
  const { allowed } = await checkRateLimit(
    buildPasswordResetRequestRateLimitKey(email, ip),
    "password-reset-request"
  );
  if (!allowed) {
    // Deliberately still `{ success: true }`-shaped from the caller's point
    // of view would be MORE consistent with the enumeration defense above,
    // but a rate-limit response has a legitimate, non-account-specific
    // reason (too many requests from this IP+email pair) that's safe to
    // surface — same tradeoff `authorize()` makes by returning `null`
    // either way for "rate-limited" and "wrong password", except here the
    // two cases (rate-limited vs. unknown email) don't need to be merged
    // because "too many attempts" doesn't confirm or deny account
    // existence on its own.
    return { success: false, error: RATE_LIMITED_MESSAGE };
  }

  const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true } });

  if (user) {
    const rawToken = await createAuthToken(user.id, "PASSWORD_RESET");
    const resetUrl = `${resolveAppUrl()}/reset-password/${rawToken}`;
    await sendEmail({
      to: email,
      subject: "Bütçem — Şifre sıfırlama",
      html: passwordResetEmailHtml(user.name, resetUrl),
      text: passwordResetEmailText(user.name, resetUrl),
    });
  }
  // No `user` → do nothing, but still fall through to the same success
  // response below. This branch takes noticeably less time than the `if`
  // branch (no token creation, no email dispatch) — a residual timing
  // signal the codebase's other two enumeration defenses (bcrypt dummy-hash
  // compare, `registerUser`'s constant path) both explicitly normalize.
  // Doing the same here (e.g. a fixed artificial delay) would help, but
  // `sendEmail`'s own latency already varies enormously (network call to
  // Resend vs. a synchronous console.log in dev) — a matched delay can't
  // meaningfully equalize against that variance, so this file accepts the
  // residual gap rather than add complexity that doesn't close it. This is
  // a deliberate, documented gap, not an oversight.

  return { success: true };
}

export type ResetPasswordResult =
  | { success: true }
  | { success: false; error: string; fieldErrors?: Partial<Record<keyof ResetPasswordInput, string[]>> };

/**
 * Server Action: consumes a password-reset token and sets a new password.
 *
 * `token` is single-use (`consumeAuthToken`) — a second submission with the
 * same token (double-click, browser back-button resubmit, an attacker
 * replaying an intercepted link after the legitimate owner already used it)
 * always fails with `TOKEN_INVALID_MESSAGE`, not a generic validation error,
 * so the UI can distinguish "this link is dead, request a new one" from
 * "your new password doesn't meet the rules".
 *
 * Also bumps `passwordChangedAt` — this is what lets the account owner
 * actually use "reset my password" to cut off a session they don't
 * recognize (stolen/shared-device cookie): see the revocation check in
 * `lib/server/auth.ts`'s `jwt` callback, which periodically compares this
 * column against the value baked into each still-live JWT.
 */
export async function resetPassword(input: unknown): Promise<ResetPasswordResult> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as Partial<
        Record<keyof ResetPasswordInput, string[]>
      >,
    };
  }
  const { token, password } = parsed.data;

  const consumed = await consumeAuthToken(token, "PASSWORD_RESET");
  if (!consumed.valid) {
    return { success: false, error: TOKEN_INVALID_MESSAGE };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST_FACTOR);
  await db.user.update({
    where: { id: consumed.userId },
    data: { passwordHash, passwordChangedAt: new Date() },
  });

  return { success: true };
}

function passwordResetEmailText(name: string, resetUrl: string): string {
  return [
    `Merhaba ${name},`,
    "",
    "Bütçem hesabınız için bir şifre sıfırlama talebi aldık. Aşağıdaki bağlantıya tıklayarak yeni bir şifre belirleyebilirsiniz:",
    resetUrl,
    "",
    "Bu bağlantı 30 dakika içinde geçerliliğini yitirecek.",
    "",
    "Bu talebi siz yapmadıysanız bu e-postayı yok sayabilirsiniz — şifreniz değişmeyecek.",
  ].join("\n");
}

function passwordResetEmailHtml(name: string, resetUrl: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#1c1917;line-height:1.5;">
    <p>Merhaba ${escapeHtml(name)},</p>
    <p>Bütçem hesabınız için bir şifre sıfırlama talebi aldık. Aşağıdaki butona tıklayarak yeni bir şifre belirleyebilirsiniz:</p>
    <p><a href="${resetUrl}" style="display:inline-block;background:#1e4d3b;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">Şifremi sıfırla</a></p>
    <p style="color:#78716c;font-size:13px;">Bu bağlantı 30 dakika içinde geçerliliğini yitirecek. Bu talebi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>
  </body></html>`;
}
