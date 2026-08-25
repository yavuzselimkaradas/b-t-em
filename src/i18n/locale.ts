// Framework-agnostic locale constants shared by request config (server),
// NextAuth callbacks, and the `updatePreferences` Server Action — the single
// source of truth for "which locales does this app support" so the list
// can't drift between those call sites.
export const SUPPORTED_LOCALES = ["tr", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "tr";

// Cookie written by `updatePreferences` (lib/server/actions/settings.ts) and
// read by `src/i18n/request.ts`'s `getRequestConfig` — deliberately a PLAIN
// cookie, not a session/JWT lookup, so a change takes effect on the very
// next request (a `router.refresh()`) without needing to re-mint the auth
// session. Also readable/writable for guest (unauthenticated) users, unlike
// the JWT `locale` snapshot in `types/next-auth.d.ts`, which only exists for
// signed-in sessions.
export const LOCALE_COOKIE_NAME = "NEXT_LOCALE";

/** Type guard — narrows an arbitrary string (cookie value, JWT claim, DB
 * column) to `Locale`, `false` for anything else (including an old/foreign
 * value someone hand-edited into a cookie, or a locale removed from
 * `SUPPORTED_LOCALES` after being persisted). Every read site in this app
 * must fall back to `DEFAULT_LOCALE` rather than trust an unchecked value. */
export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
