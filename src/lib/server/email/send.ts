import "server-only";

import { Resend } from "resend";

/**
 * Outbound transactional email (password reset, email verification) — the
 * only two callers today are src/lib/server/actions/password-reset.ts and
 * email-verification.ts.
 *
 * ── BACKEND SELECTION ────────────────────────────────────────────────────
 * Resend, same reasoning family as rate-limit.ts's Upstash choice: a REST
 * API (works from serverless/edge, no persistent SMTP connection to manage),
 * a generous free tier, and the de-facto default for a Next.js app that
 * doesn't already have mail infra.
 *
 * When `RESEND_API_KEY` is ABSENT (local dev without a Resend account), this
 * falls back to logging the email to the server console instead of sending
 * it — this fallback is a DEVELOPMENT CONVENIENCE ONLY, same caveat as
 * rate-limit.ts's in-memory limiter:
 *
 *   ⚠️  DO NOT RELY ON THE CONSOLE FALLBACK IN PRODUCTION. A user who
 *   requests a password reset or a verification email would never receive
 *   it — the link only ever reaches your terminal.
 *
 * If `NODE_ENV === "production"` and `RESEND_API_KEY` is missing, we log an
 * error (once, on module load) for the same "never fail silently" reason
 * rate-limit.ts does.
 */

const apiKey = process.env.RESEND_API_KEY;
const resendConfigured = Boolean(apiKey);

/** True when the real Resend client is active; false means the
 * console-logging fallback is in use. Exported so ops tooling can assert on
 * it, same as rate-limit.ts's `isRateLimitRedisBacked`. */
export const isEmailProviderConfigured = resendConfigured;

if (!resendConfigured && process.env.NODE_ENV === "production") {
  console.error(
    "[email] RESEND_API_KEY not set in production. Falling back to console " +
      "logging — password-reset and verification emails will NEVER reach a " +
      "real inbox. Set RESEND_API_KEY (and FROM_EMAIL) to fix."
  );
}

const resend = resendConfigured ? new Resend(apiKey) : null;

// Resend's sandbox sender (`onboarding@resend.dev`) works without any
// domain verification, which is why it's the default here — good enough to
// send real mail in early development against a Resend account that hasn't
// verified a custom domain yet. Production should set FROM_EMAIL to an
// address on a domain verified in the Resend dashboard.
const DEFAULT_FROM = "Bütçem <onboarding@resend.dev>";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Plain-text fallback — required, not derived from `html`, so callers
   * can't forget it and ship an email that renders as nothing in a
   * text-only mail client. */
  text: string;
}

/**
 * Sends one transactional email. NEVER throws — a failed/unconfigured send
 * must not take down the Server Action that triggered it (a password-reset
 * request in particular must resolve the same generic "check your inbox"
 * response whether or not the email actually went out, to avoid leaking
 * account existence — see requestPasswordReset's doc comment). Failures are
 * logged, not surfaced to the caller as a thrown error; the caller decides
 * what (if anything) to tell the end user.
 */
export async function sendEmail(input: SendEmailInput): Promise<{ sent: boolean }> {
  if (!resend) {
    console.log(
      `[email] RESEND_API_KEY not set — logging instead of sending.\n` +
        `  To: ${input.to}\n` +
        `  Subject: ${input.subject}\n` +
        `  ---- text body ----\n${input.text}\n  --------------------`
    );
    return { sent: false };
  }

  try {
    const result = await resend.emails.send({
      from: process.env.FROM_EMAIL || DEFAULT_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (result.error) {
      console.error("[email] Resend API returned an error", result.error);
      return { sent: false };
    }
    return { sent: true };
  } catch (error) {
    console.error("[email] sendEmail: unexpected failure", error);
    return { sent: false };
  }
}
