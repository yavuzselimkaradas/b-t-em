import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

import { db } from "@/lib/server/db";
import { loginSchema } from "@/lib/validation/auth";
import { buildLoginRateLimitKey, checkRateLimit, getClientIp } from "@/lib/server/rate-limit";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/locale";

// Precomputed bcrypt hash of a random string that is not, and will never be,
// a real user's password. Used as the compare target when no user is found,
// so an unknown-email lookup takes the same amount of time as a known-email
// one — otherwise the presence/absence of `db.user.findUnique` + the ~100-300ms
// bcrypt.compare() call becomes a timing side-channel that leaks which emails
// are registered, even though the returned error message is generic.
const DUMMY_BCRYPT_HASH = "$2b$12$83DjN5j/2qZI7C0Dg4Z4fu9WWHsA6CGSf93.DSxucWIUvqngTgcvW";

// How often the `jwt` callback re-checks `token.pwv` against the DB's
// current `User.passwordChangedAt` (see that callback below). NOT on every
// request — this app's Proxy (src/proxy.ts) calls `auth()` on nearly every
// route, so an unconditional per-request DB read would turn a pure,
// stateless JWT session into a database round-trip on every page load
// site-wide. Checking at most once per this interval instead bounds the
// cost to "once per active user per N minutes" while still cutting off a
// stolen/still-live session within a few minutes of a password reset —
// a deliberate, bounded-delay-for-much-lower-DB-load trade-off, not an
// oversight.
const PASSWORD_VERSION_REVALIDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    // Credentials provider only supports JWT sessions (no database adapter is
    // configured here) — the session is a signed cookie, not a DB lookup.
    strategy: "jwt",
    // Keep sessions short-lived for a financial app rather than trusting
    // NextAuth's 30-day default.
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "E-posta", type: "email" },
        password: { label: "Şifre", type: "password" },
      },
      async authorize(rawCredentials, request) {
        // `rawCredentials` is untrusted input from the client — validate its
        // shape before touching the database.
        const parsed = loginSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        // Gate before touching the DB or bcrypt: 10 attempts / 15 min per
        // email+IP pair. A rate-limited attempt returns `null`, the same
        // generic "CredentialsSignin" NextAuth already shows for a wrong
        // password — the caller can't distinguish "rate-limited" from
        // "wrong credentials" from the response alone.
        const ip = getClientIp(request);
        const { allowed } = await checkRateLimit(buildLoginRateLimitKey(email, ip), "login");
        if (!allowed) return null;

        const user = await db.user.findUnique({ where: { email } });

        // Always run bcrypt.compare, even when no user was found, against a
        // fixed dummy hash — this equalizes response time between "unknown
        // email" and "known email, wrong password" so timing can't be used
        // to enumerate registered accounts.
        const passwordMatches = await bcrypt.compare(
          password,
          user?.passwordHash ?? DUMMY_BCRYPT_HASH
        );
        if (!user || !passwordMatches) return null;

        // Only return the minimal, non-sensitive fields NextAuth needs.
        // Never return passwordHash. `preferredLanguage` is carried through
        // so the `jwt` callback below can snapshot it onto the token at
        // sign-in time — see `src/i18n/request.ts` for how that snapshot is
        // later consumed (as a fallback behind the `NEXT_LOCALE` cookie).
        // `passwordChangedAt` seeds `token.pwv` — see the `jwt` callback.
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          preferredLanguage: user.preferredLanguage,
          passwordChangedAt: user.passwordChangedAt,
        };
      },
    }),
  ],
  callbacks: {
    // Persist the user id onto the JWT so it survives across requests
    // without a database round-trip on every page load. Also snapshots
    // `preferredLanguage` onto `token.locale` at sign-in time — NOT
    // re-validated against `SUPPORTED_LOCALES` here (that happens on READ,
    // in the `session` callback below), since an invalid/stale value here
    // would just be carried through unchanged either way.
    //
    // Also the ONE place a `resetPassword`/`changePassword` call can
    // actually invalidate this session: this callback runs on every
    // `auth()` call (Auth.js re-invokes `jwt` "whenever a session is
    // accessed", not just at sign-in), so it's the single choke point every
    // consumer of `auth()` — Proxy AND every Server Action — goes through.
    // Returning `null` here is Auth.js's documented way to end a session
    // early; every caller of `auth()` then sees `null`, same as a truly
    // signed-out visitor (`session?.user?.id` checks throughout this
    // codebase already treat that as "not authenticated").
    async jwt({ token, user }) {
      if (user?.id) {
        token.id = user.id;
        token.locale = user.preferredLanguage;
        token.pwv = user.passwordChangedAt?.getTime() ?? 0;
        token.pwvCheckedAt = Date.now();
        return token;
      }

      if (typeof token.id !== "string") {
        // No user id on the token at all (shouldn't normally happen once
        // signed in) — nothing to revalidate against, pass through as-is
        // rather than force-invalidating on an unrelated codepath.
        return token;
      }

      const checkedAt = typeof token.pwvCheckedAt === "number" ? token.pwvCheckedAt : 0;
      if (Date.now() - checkedAt < PASSWORD_VERSION_REVALIDATE_INTERVAL_MS) {
        return token;
      }

      const current = await db.user.findUnique({
        where: { id: token.id },
        select: { passwordChangedAt: true },
      });
      if (!current) {
        // Account no longer exists (e.g. hard-deleted) — cut the session.
        return null;
      }

      const currentPwv = current.passwordChangedAt.getTime();
      // `token.pwv === undefined` covers a JWT minted before this field
      // existed (e.g. still-live at deploy time) — there is no prior
      // baseline to compare against, so adopt the DB's current value
      // instead of force-signing-out every existing session on deploy.
      if (typeof token.pwv === "number" && token.pwv !== currentPwv) {
        return null;
      }

      token.pwv = currentPwv;
      token.pwvCheckedAt = Date.now();
      return token;
    },
    // Expose the user id on the session object so server code (Server
    // Actions, Route Handlers) can derive the authenticated user's identity
    // from `session.user.id` instead of trusting client-supplied ids.
    async session({ session, token }) {
      if (session.user && typeof token.id === "string") {
        session.user.id = token.id;
      }
      // Validated on READ, not on write: a JWT minted before this field
      // existed has `token.locale === undefined`, and a locale later removed
      // from `SUPPORTED_LOCALES` could still be sitting in an old,
      // still-valid (7-day) token — either case must fall back to
      // `DEFAULT_LOCALE` rather than surface an invalid value or throw.
      if (session.user) {
        const tokenLocale = typeof token.locale === "string" ? token.locale : undefined;
        session.user.locale = isSupportedLocale(tokenLocale) ? tokenLocale : DEFAULT_LOCALE;
      }
      return session;
    },
  },
});
