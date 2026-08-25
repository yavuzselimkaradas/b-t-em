import { NextResponse } from "next/server";

import { auth } from "@/lib/server/auth";

// Next.js 16 renamed `middleware.ts` to `proxy.ts` (functionality is
// unchanged, see AGENTS.md / node_modules/next/dist/docs/.../proxy.md).
//
// This performs an OPTIMISTIC auth check only, reading the signed JWT
// session cookie via NextAuth's `auth()` wrapper — it does not hit the
// database. Per Next.js's own auth guidance, Proxy must never be the only
// authorization boundary: every Server Action and Route Handler under
// src/lib/server/** re-derives the session independently and is the real
// security boundary. This file exists purely so an unauthenticated visitor
// is redirected before any protected page renders, and so a logged-in user
// isn't shown the login/register forms again.

// "/dashboard" ve "/transactions" kasıtlı olarak burada DEĞİL: uygulama
// hesap açmadan da (misafir modu, tarayıcı localStorage'ında) kullanılabilir
// olmalı — bkz. CLAUDE.md "Misafir modu" kararı. Bu iki sayfa, oturum var mı
// yok mu diye kendi içinde bakıp veri kaynağını (sunucu vs. yerel) buna göre
// seçiyor. Aile planı/bütçe/tekrarlayan işlem/ayarlar gibi doğası gereği bir
// hesap gerektiren sayfalar korumalı kalmaya devam ediyor.
// "/recurring" kasıtlı olarak burada DA DEĞİL — ama farklı bir sebeple:
// RecurringTransaction Prisma modeli ve `lib/domain/recurring/` iskeleti var,
// ama bu turda ne bir Server Action/CRUD ne bir sayfa (`app/(app)/recurring`)
// ne de üretim cron'u yazıldı (bkz. proje son-kontrol raporu). Bu prefix
// burada dursaydı, oturum açmış bir kullanıcı `/recurring`'e gittiğinde
// "korumalı ama arkasında hiçbir şey olmayan" bir 404 ile karşılaşırdı —
// listeden çıkarmak bunu önlüyor. Özellik gerçekten inşa edildiğinde bu
// prefix geri eklenmeli.
const PROTECTED_PREFIXES = ["/budgets", "/family", "/settings", "/invite"];

const AUTH_ONLY_PAGES = ["/login", "/register"];

function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export default auth((req) => {
  const { nextUrl } = req;
  const isLoggedIn = Boolean(req.auth);
  const { pathname } = nextUrl;

  if (matchesPrefix(pathname, PROTECTED_PREFIXES) && !isLoggedIn) {
    const loginUrl = new URL("/login", nextUrl);
    // Preserve the query string too (e.g. `/transactions?ay=2026-08`), not
    // just the path, so the user lands back exactly where they left off.
    const callbackUrl = nextUrl.search ? `${pathname}${nextUrl.search}` : pathname;
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(loginUrl);
  }

  if (matchesPrefix(pathname, AUTH_ONLY_PAGES) && isLoggedIn) {
    return NextResponse.redirect(new URL("/dashboard", nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  // Run on every route except static assets, image optimization, and the
  // auth API routes themselves (NextAuth's own [...nextauth] route must
  // stay reachable so the sign-in/sign-out POSTs — and Server Actions,
  // which piggyback on the page route they're invoked from — aren't
  // blocked).
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|ico)$).*)"],
};
