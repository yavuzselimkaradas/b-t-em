"use server";

import { db } from "@/lib/server/db";
import { auth } from "@/lib/server/auth";
import { verifyEmailSchema } from "@/lib/validation/auth";
import {
  buildEmailVerificationResendRateLimitKey,
  checkRateLimit,
} from "@/lib/server/rate-limit";
import { createAuthToken, consumeAuthToken } from "@/lib/server/auth-tokens";
import { sendEmail } from "@/lib/server/email/send";
import { resolveAppUrl, escapeHtml } from "@/lib/server/email/helpers";

// STABLE KEYS (`errors.<camelCase>`) — see password-reset.ts's identical
// i18n note. This file never imports next-intl.
const UNAUTHENTICATED_MESSAGE = "errors.unauthenticated";
const VALIDATION_ERROR_MESSAGE = "errors.validationFailed";
const TOKEN_INVALID_MESSAGE = "errors.verificationTokenInvalid";
const RATE_LIMITED_MESSAGE = "errors.rateLimited";
const ALREADY_VERIFIED_MESSAGE = "errors.emailAlreadyVerified";

/**
 * Fire-and-forget helper called by `registerUser` (lib/server/actions/auth.ts)
 * right after a new account is created — creates a token and emails the
 * verification link. Not itself exported as a Server Action (it needs no
 * input validation of its own; the caller already has a trusted `userId`/
 * `email`/`name` straight from the row it just inserted) — the PUBLIC
 * resend path is `resendVerificationEmail` below, which re-derives the same
 * three values from the authenticated session instead of trusting a caller-
 * supplied id.
 *
 * Deliberately swallows its own errors (never throws) — a failed
 * verification email must not fail the registration that triggered it; the
 * account still gets created, the person just won't have a verification
 * email waiting (they can use the "resend" button on the reminder banner
 * once signed in).
 */
export async function sendVerificationEmailFor(user: {
  id: string;
  email: string;
  name: string;
}): Promise<void> {
  try {
    const rawToken = await createAuthToken(user.id, "EMAIL_VERIFICATION");
    const verifyUrl = `${resolveAppUrl()}/verify-email/${rawToken}`;
    await sendEmail({
      to: user.email,
      subject: "Bütçem — E-posta adresini doğrula",
      html: verificationEmailHtml(user.name, verifyUrl),
      text: verificationEmailText(user.name, verifyUrl),
    });
  } catch (error) {
    console.error("sendVerificationEmailFor: failed to create/send verification email", error);
  }
}

export type VerifyEmailResult = { success: true } | { success: false; error: string };

/**
 * Server Action: consumes an email-verification token, sets
 * `User.emailVerifiedAt`. Called directly (awaited) from
 * `src/app/(auth)/verify-email/[token]/page.tsx` — a Server Component can
 * call a Server Action as a plain async function, no form/client boundary
 * needed for this one-shot "resolve on page load" flow.
 *
 * That call site re-runs THIS action on every request to the page (initial
 * visit, a plain page refresh, browser back/forward, an RSC re-fetch) — not
 * just the first click. A naive "second consumption always fails" read
 * would make a legitimate first-time success followed by, e.g., hitting
 * refresh on the success screen come back as `TOKEN_INVALID_MESSAGE` ("bu
 * bağlantının süresi dolmuş ya da geçersiz"), even though the account is
 * verified and nothing is actually wrong — misleading the person into
 * thinking their verification failed and possibly clicking "resend".
 *
 * So on `already-used` specifically, this re-checks the token's owner: if
 * their email is ALREADY verified, that's this exact scenario (a stale
 * replay of a link that already did its job) and resolves success again,
 * idempotently — no second write, `emailVerifiedAt` is already set. Only a
 * token that's used-but-the-owner-still-isn't-verified (not currently
 * reachable — `consumeAuthToken` marks `usedAt` and this function's own
 * `db.user.update` are effectively one unit of work for THIS purpose — but
 * cheap to guard regardless) falls through to the genuine "invalid" error,
 * same as `not-found`/`expired`.
 */
export async function verifyEmail(input: unknown): Promise<VerifyEmailResult> {
  const parsed = verifyEmailSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: VALIDATION_ERROR_MESSAGE };
  }

  const consumed = await consumeAuthToken(parsed.data.token, "EMAIL_VERIFICATION");
  if (!consumed.valid) {
    if (consumed.reason === "already-used") {
      const owner = await db.user.findUnique({
        where: { id: consumed.userId },
        select: { emailVerifiedAt: true },
      });
      if (owner?.emailVerifiedAt) {
        return { success: true };
      }
    }
    return { success: false, error: TOKEN_INVALID_MESSAGE };
  }

  await db.user.update({
    where: { id: consumed.userId },
    data: { emailVerifiedAt: new Date() },
  });

  return { success: true };
}

export type ResendVerificationEmailResult =
  | { success: true }
  | { success: false; error: string };

/**
 * Server Action: re-sends the CURRENT signed-in user's own verification
 * email — the "resend" button on `EmailVerificationBanner`
 * (components/app/email-verification-banner.tsx). Unlike
 * `sendVerificationEmailFor`, this derives `userId`/`email`/`name` from the
 * authenticated session, never from caller input, so it can only ever
 * target the caller's own account.
 */
export async function resendVerificationEmail(): Promise<ResendVerificationEmailResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const { allowed } = await checkRateLimit(
    buildEmailVerificationResendRateLimitKey(session.user.id),
    "email-verification-resend"
  );
  if (!allowed) {
    return { success: false, error: RATE_LIMITED_MESSAGE };
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, emailVerifiedAt: true },
  });
  if (!user) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }
  if (user.emailVerifiedAt) {
    return { success: false, error: ALREADY_VERIFIED_MESSAGE };
  }

  await sendVerificationEmailFor(user);
  return { success: true };
}

export type MyVerificationStatusResult =
  | { success: true; data: { verified: boolean } }
  | { success: false; error: string };

/**
 * Server Action: whether the signed-in user's email is verified — the
 * `(app)/layout.tsx` shell's data source for deciding whether to render
 * `EmailVerificationBanner`. A dedicated single-field query rather than
 * reusing `getMyProfile` (settings.ts): that action returns the full
 * profile-editing form's data, more than this shell-level check needs, and
 * coupling the two would mean any future change to `MyProfile`'s shape
 * risks touching an unrelated render path (every page, via the layout).
 */
export async function getMyVerificationStatus(): Promise<MyVerificationStatusResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { emailVerifiedAt: true },
  });
  if (!user) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  return { success: true, data: { verified: user.emailVerifiedAt !== null } };
}

function verificationEmailText(name: string, verifyUrl: string): string {
  return [
    `Merhaba ${name},`,
    "",
    "Bütçem hesabınıza hoş geldiniz! E-posta adresinizi doğrulamak için aşağıdaki bağlantıya tıklayın:",
    verifyUrl,
    "",
    "Bu bağlantı 24 saat içinde geçerliliğini yitirecek.",
    "",
    "Bu hesabı siz oluşturmadıysanız bu e-postayı yok sayabilirsiniz.",
  ].join("\n");
}

function verificationEmailHtml(name: string, verifyUrl: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#1c1917;line-height:1.5;">
    <p>Merhaba ${escapeHtml(name)},</p>
    <p>Bütçem hesabınıza hoş geldiniz! E-posta adresinizi doğrulamak için aşağıdaki butona tıklayın:</p>
    <p><a href="${verifyUrl}" style="display:inline-block;background:#1e4d3b;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">E-postamı doğrula</a></p>
    <p style="color:#78716c;font-size:13px;">Bu bağlantı 24 saat içinde geçerliliğini yitirecek. Bu hesabı siz oluşturmadıysanız bu e-postayı yok sayabilirsiniz.</p>
  </body></html>`;
}
