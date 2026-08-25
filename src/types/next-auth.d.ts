import type { DefaultSession } from "next-auth";

// Module augmentation: add `id` to the session/JWT user shape so
// `session.user.id` is typed everywhere it's read (Server Actions, Route
// Handlers, Server Components) instead of requiring `as` casts at each call
// site.
//
// `locale`/`preferredLanguage` (i18n, next-intl): see `lib/server/auth.ts`'s
// `authorize`/`jwt`/`session` callbacks and `src/i18n/request.ts` for the
// full flow. `Session.user.locale` is ALWAYS a validated `Locale` value
// (`"tr" | "en"`) by the time it reaches a caller — narrowed from
// `JWT.locale: string | undefined` (untrusted: may be absent on an old JWT,
// or hold a value later removed from `SUPPORTED_LOCALES`) in the `session`
// callback via `isSupportedLocale`. Typed as the widened `string` here (not
// `Locale`) rather than importing `Locale` from `@/i18n/locale` into this
// ambient `.d.ts` — keeps this file dependency-free, same as the rest of
// this module's minimal-surface augmentation style; callers that need the
// narrow type can re-narrow with `isSupportedLocale` themselves.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      locale?: string;
    } & DefaultSession["user"];
  }

  interface User {
    preferredLanguage?: string;
    // Only read by the `jwt` callback at sign-in time (to seed `JWT.pwv`
    // below) — never exposed to the client, never copied onto `Session`.
    passwordChangedAt?: Date | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    locale?: string;
    // "Password version" — a snapshot (epoch ms) of `User.passwordChangedAt`
    // at the moment this JWT was minted, plus when it was last re-checked
    // against the DB. See lib/server/auth.ts's `jwt` callback for the
    // revocation mechanism this enables: a `resetPassword`/`changePassword`
    // call bumps the DB column, and the next periodic re-check notices the
    // mismatch and invalidates this token — without it, a JWT-strategy
    // session has NO way to be revoked before its `maxAge` (7 days) expires
    // on its own, e.g. after the account owner deliberately resets their
    // password specifically to cut off a session they don't recognize.
    pwv?: number;
    pwvCheckedAt?: number;
  }
}
