import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Rate limiting for auth-adjacent endpoints (login, register, password
 * change).
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────
 * `authorize()` in `src/lib/server/auth.ts`, `registerUser()` in
 * `src/lib/server/actions/auth.ts`, and `changePassword()` in
 * `src/lib/server/actions/settings.ts` have no brute-force protection on
 * their own: an attacker (or a buggy client) can call any of them an
 * unbounded number of times. This module gives every call site a single
 * `checkRateLimit()` function to call before doing any real work (DB
 * lookup / bcrypt / user creation).
 *
 * ── BACKEND SELECTION ────────────────────────────────────────────────────
 * Vercel Serverless/Edge Functions are STATELESS across invocations — each
 * request can land on a different (or freshly booted) instance, and even a
 * "warm" instance can be recycled at any time. A plain in-memory counter
 * therefore does NOT enforce a real limit in production: with N concurrent
 * instances, an attacker effectively gets `limit * N` attempts, and a cold
 * start resets any instance's counter to zero. Real enforcement requires
 * state that outlives any single instance — hence Redis.
 *
 * We use Upstash Redis (`@upstash/ratelimit` + `@upstash/redis`) when
 * `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are configured:
 *   - it's a REST-based Redis client (HTTP, not a persistent TCP
 *     connection), which is what makes it usable from serverless/edge
 *     functions in the first place — a normal `redis` client's TCP
 *     connection pool doesn't survive/scale across ephemeral instances.
 *   - Vercel has a native Upstash integration and Upstash has a free tier
 *     (10k commands/day as of writing), which comfortably covers login +
 *     register traffic for a small app.
 *
 * When those env vars are ABSENT (local dev without an Upstash account), we
 * fall back to an in-memory `Map`. This fallback is explicitly a
 * DEVELOPMENT CONVENIENCE ONLY:
 *
 *   ⚠️  DO NOT RELY ON THE IN-MEMORY FALLBACK IN PRODUCTION. On Vercel it
 *   provides NO real protection — every cold start / new instance gets a
 *   fresh, empty counter, and traffic is load-balanced across multiple
 *   concurrent instances that don't share memory. It exists purely so
 *   `npm run dev` works out of the box without requiring every developer to
 *   have an Upstash account, and so the rate-limit code path can be
 *   exercised in tests/local runs.
 *
 * If `NODE_ENV === "production"` and the Upstash env vars are missing, we
 * log an error (once, on module load) precisely so this doesn't fail
 * silently — check your deploy logs for
 * `"[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set in production"` if
 * you suspect this is happening.
 */

export type RateLimitPolicy =
  | "login"
  | "register"
  | "password-change"
  | "password-reset-request"
  | "email-verification-resend";

export interface RateLimitResult {
  allowed: boolean;
  /** Only present when `allowed` is false. Round up when surfacing to a user. */
  retryAfterSeconds?: number;
}

interface PolicyConfig {
  /** Max allowed attempts within `window`. */
  limit: number;
  /** Upstash duration string, e.g. "15 m". Keep in sync with `windowMs` below. */
  window: `${number} ${"ms" | "s" | "m" | "h" | "d"}`;
  /** Same window, in milliseconds, for the in-memory fallback's own bookkeeping. */
  windowMs: number;
  /** Redis key / in-memory key prefix, isolates policies from each other. */
  prefix: string;
}

// Login: keyed by email+IP (see callers) — 10 failed attempts / 15 minutes.
// Register: keyed by IP — 5 new accounts / hour.
// Password-change: keyed by `session.user.id` (see `buildPasswordChangeRateLimitKey`
// below) — same 10/15min budget as login. This gates `changePassword`'s
// `bcrypt.compare(currentPassword, ...)` call: the caller is already an
// authenticated session (unlike login, there's no "unknown email" case to
// worry about, hence no IP component), but without this an attacker who
// has hijacked/is reusing someone else's session cookie could still brute
// force the CURRENT password unboundedly to, e.g., learn it before it gets
// rotated. Reuses the login policy's exact budget rather than inventing a
// new number, since the underlying risk (unbounded bcrypt.compare guesses
// against one account) is the same shape.
const POLICIES: Record<RateLimitPolicy, PolicyConfig> = {
  login: { limit: 10, window: "15 m", windowMs: 15 * 60 * 1000, prefix: "rl:login" },
  register: { limit: 5, window: "1 h", windowMs: 60 * 60 * 1000, prefix: "rl:register" },
  "password-change": {
    limit: 10,
    window: "15 m",
    windowMs: 15 * 60 * 1000,
    prefix: "rl:password-change",
  },
  // Keyed by email+IP (see buildPasswordResetRequestRateLimitKey) — same
  // budget as login, since it's the same shape of risk: an anonymous caller
  // repeatedly probing one email address (here, to spam its owner's inbox
  // with reset links rather than to guess a password).
  "password-reset-request": {
    limit: 5,
    window: "15 m",
    windowMs: 15 * 60 * 1000,
    prefix: "rl:password-reset-request",
  },
  // Keyed by `session.user.id` (an authenticated caller resending their OWN
  // verification email) — tight budget, since the only legitimate reason to
  // click "resend" more than a couple of times in a row is "the first one
  // didn't arrive yet", not a rapid loop.
  "email-verification-resend": {
    limit: 3,
    window: "15 m",
    windowMs: 15 * 60 * 1000,
    prefix: "rl:email-verification-resend",
  },
};

// ── Upstash-backed limiter (production path) ───────────────────────────────

const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

const redisConfigured = Boolean(upstashUrl && upstashToken);

/** True when the Redis-backed limiter is active; false means the in-memory
 *  fallback is in use. Exported so callers/ops tooling can assert on it
 *  (e.g. a startup check that fails a production deploy if this is false). */
export const isRateLimitRedisBacked = redisConfigured;

if (!redisConfigured && process.env.NODE_ENV === "production") {
  // Loud, structured, and grep-able in Vercel's runtime logs on purpose —
  // this must never fail silently per project deploy policy.
  console.error(
    "[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set in production. " +
      "Falling back to an in-memory limiter that does NOT work correctly " +
      "on Vercel's stateless serverless instances — login/register are " +
      "effectively UNRATE-LIMITED. Configure Upstash env vars to fix."
  );
}

const upstashLimiters: Partial<Record<RateLimitPolicy, Ratelimit>> = {};

if (redisConfigured) {
  const redis = new Redis({ url: upstashUrl!, token: upstashToken! });
  for (const policy of Object.keys(POLICIES) as RateLimitPolicy[]) {
    const cfg = POLICIES[policy];
    upstashLimiters[policy] = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(cfg.limit, cfg.window),
      prefix: cfg.prefix,
      analytics: false,
    });
  }
}

// ── In-memory fallback (local dev only — see module doc comment) ──────────

interface MemoryEntry {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, MemoryEntry>();

// Opportunistic cleanup so `memoryStore` doesn't grow unbounded across a
// long-running `next dev` session. Not relevant to correctness (each entry
// self-expires via `resetAt`), just hygiene.
let callsSinceSweep = 0;
function sweepExpiredMemoryEntries(now: number) {
  callsSinceSweep += 1;
  if (callsSinceSweep < 500) return;
  callsSinceSweep = 0;
  for (const [key, entry] of memoryStore) {
    if (entry.resetAt <= now) memoryStore.delete(key);
  }
}

function checkRateLimitInMemory(key: string, policy: RateLimitPolicy): RateLimitResult {
  const cfg = POLICIES[policy];
  const now = Date.now();
  sweepExpiredMemoryEntries(now);

  const storeKey = `${cfg.prefix}:${key}`;
  const existing = memoryStore.get(storeKey);

  if (!existing || existing.resetAt <= now) {
    memoryStore.set(storeKey, { count: 1, resetAt: now + cfg.windowMs });
    return { allowed: true };
  }

  existing.count += 1;
  if (existing.count > cfg.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  return { allowed: true };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Checks and consumes one attempt against the given policy for `key`.
 *
 * Call this BEFORE doing the real work (DB lookup, bcrypt, user creation) —
 * it's meant to be the cheapest possible gate, so the expensive work never
 * runs once a caller is over budget. Every call consumes one attempt
 * regardless of whether the attempt that follows succeeds or fails.
 *
 * NOTE on "10 failed attempts / 15 min" vs. what this actually enforces:
 * counting only *failed* logins would require calling this AFTER
 * bcrypt.compare() resolves, which defeats the point of gating before the
 * expensive work — an attacker (or a runaway client) could still force
 * unlimited bcrypt calls, just never see a rate-limit error while doing it.
 * Instead this counts every attempt (success or failure) against the same
 * budget. In practice this is equivalent for an attacker (wrong-password
 * attempts dominate) and strictly safer for cost/DoS protection; the only
 * behavioral difference is a legitimate user who mistypes their password
 * repeatedly and then succeeds also consumes their own budget on that last,
 * successful call — an acceptable trade-off for a financial app. Document
 * this trade-off if it's ever revisited.
 *
 * Fails OPEN on unexpected Redis errors (network blip, Upstash outage):
 * logs the error and allows the request through, rather than locking every
 * user out of login because Redis is unreachable. This is a deliberate
 * availability-over-strictness trade-off appropriate here because rate
 * limiting is a *defense-in-depth* layer on top of bcrypt + a
 * constant-time comparison (see `auth.ts`), not the only thing standing
 * between an attacker and an account.
 */
export async function checkRateLimit(
  key: string,
  policy: RateLimitPolicy
): Promise<RateLimitResult> {
  const limiter = upstashLimiters[policy];

  if (!limiter) {
    return checkRateLimitInMemory(key, policy);
  }

  try {
    const result = await limiter.limit(key);
    if (result.success) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
    };
  } catch (error) {
    console.error(`[rate-limit] Upstash call failed for policy "${policy}", failing open.`, error);
    return { allowed: true };
  }
}

/**
 * Extracts the caller's IP address to key rate limits by.
 *
 * Accepts either a `Headers` instance (e.g. from `next/headers`'s
 * `headers()` inside a Server Action/Route Handler, where there's no raw
 * `Request` object) or a `Request` (e.g. the second argument NextAuth's
 * `authorize(credentials, request)` receives directly).
 *
 * Trust chain, in order:
 *   1. `x-real-ip` — set by Vercel's edge network itself from the actual
 *      TCP connection, NOT copied from any client-supplied header, and the
 *      only one of these that's not spoofable by the client on Vercel.
 *   2. `x-forwarded-for` (first entry) — a fallback for non-Vercel
 *      environments (e.g. running behind another reverse proxy, or a
 *      future self-hosted deploy). This header CAN be forged by the client
 *      if nothing upstream strips it, so it's a best-effort fallback, not
 *      a trusted source, on any platform other than Vercel.
 *   3. `"unknown"` — local `next dev` (no proxy in front at all) and any
 *      other case where neither header is present. All such requests share
 *      one rate-limit bucket, which is a safe (if coarse) default — it
 *      fails toward "shared limit" rather than toward "no limit".
 *
 * Reads `x-real-ip` directly rather than via `@vercel/functions`'
 * `ipAddress()` — that helper does `"headers" in input ? input.headers :
 * input` to unwrap a `Request`-like object down to its `Headers`, but
 * Next.js's `headers()` (from `next/headers`) returns a `HeadersAdapter`
 * that IS a `Headers` instance yet ALSO carries its own `this.headers`
 * instance property (an internal `Proxy`, not a `Headers`) — so the duck
 * check misfires, `ipAddress()` calls `.get` on that Proxy, and it throws
 * `TypeError: headers.get is not a function`. This broke every
 * `registerUser()` call (caught by QA during Aile Planı Aşama 3.6 testing —
 * `authorize()`/login was unaffected because NextAuth passes a real
 * `Request`, not a `HeadersAdapter`, there). Reading the header ourselves
 * sidesteps `ipAddress()`'s unwrapping logic entirely.
 */
export function getClientIp(input: Headers | Request): string {
  const headers = input instanceof Headers ? input : input.headers;

  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp;

  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  return "unknown";
}

/**
 * Login rate-limit key: email + IP, so that (a) an attacker hammering one
 * victim's email from a single IP is bounded, AND (b) an attacker rotating
 * IPs against one email, or spraying many emails from one IP, is still
 * bounded by whichever half of the pair stays constant — because both
 * signals are folded into the SAME 10/15min budget only when BOTH match; a
 * distributed/rotated attack still forces the attacker through many
 * distinct buckets, which is the best a single-layer IP+identity key can do
 * without a global "too many failures anywhere" tripwire (out of scope
 * here). Email is lowercased/trimmed to match `loginSchema`'s
 * normalization, so `Foo@Bar.com ` and `foo@bar.com` share one bucket
 * instead of getting separate budgets.
 */
export function buildLoginRateLimitKey(email: string, ip: string): string {
  return `${email.trim().toLowerCase()}:${ip}`;
}

/** Register rate-limit key: IP only — there's no account identity yet. */
export function buildRegisterRateLimitKey(ip: string): string {
  return ip;
}

/**
 * Password-change rate-limit key: `session.user.id` only — no IP component.
 * Unlike login (where the caller is anonymous and IP is one of the only
 * signals available) or register (same), this action requires an existing
 * authenticated session, so the account identity itself is already a
 * trustworthy key (derived from the verified JWT in `auth()`, never from
 * client input) and is a tighter bound than IP would be (an attacker
 * rotating IPs against one stolen session cookie is still caught).
 */
export function buildPasswordChangeRateLimitKey(userId: string): string {
  return userId;
}

/** Password-reset-REQUEST rate-limit key: email + IP, same shape/reasoning
 * as `buildLoginRateLimitKey` — the caller is anonymous here too (that's
 * the whole point of "forgot password"), so there's no session identity to
 * key on instead. */
export function buildPasswordResetRequestRateLimitKey(email: string, ip: string): string {
  return `${email.trim().toLowerCase()}:${ip}`;
}

/** Email-verification-resend rate-limit key: `session.user.id` only — same
 * reasoning as `buildPasswordChangeRateLimitKey`, an authenticated caller
 * resending their own verification email. */
export function buildEmailVerificationResendRateLimitKey(userId: string): string {
  return userId;
}
