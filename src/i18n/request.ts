import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { auth } from "@/lib/server/auth";
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, isSupportedLocale } from "@/i18n/locale";

/**
 * Request-scoped locale resolution — no URL locale prefix (product decision:
 * "URL'de dil görünmesin"), so the active locale is derived per-request
 * instead of from the route.
 *
 * Priority, each step falling through to the next only if the previous one
 * is absent/invalid:
 *  1. `NEXT_LOCALE` cookie — written by `updatePreferences`
 *     (lib/server/actions/settings.ts) the moment a signed-in user changes
 *     their language preference, and freely readable/writable for a guest
 *     (unauthenticated) visitor too, so this is the ONLY source that works
 *     for both. Takes priority over the JWT snapshot below so a same-session
 *     language change is honored immediately (`router.refresh()`) without
 *     waiting for the JWT to be re-minted.
 *  2. `session.user.locale` — the JWT's `preferredLanguage` snapshot (see
 *     `lib/server/auth.ts`'s `jwt`/`session` callbacks), used when a
 *     signed-in user has no `NEXT_LOCALE` cookie yet (e.g. first request
 *     after signing in on a new device/browser that never set one).
 *  3. `DEFAULT_LOCALE` ("tr") — guest with no cookie, or any unexpected/
 *     invalid value in either of the above.
 *
 * Deliberately does NOT query the database — `session.user.locale` is a
 * point-in-time JWT snapshot (may lag a preference change made in another
 * session/device until that JWT is refreshed), not a live read of
 * `User.preferredLanguage`; re-fetching per request would defeat the point
 * of a stateless JWT session and add a DB round-trip to every single page
 * render.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE_NAME)?.value;

  let locale = isSupportedLocale(cookieLocale) ? cookieLocale : undefined;

  if (!locale) {
    const session = await auth();
    const sessionLocale = session?.user?.locale;
    locale = isSupportedLocale(sessionLocale) ? sessionLocale : undefined;
  }

  locale ??= DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
