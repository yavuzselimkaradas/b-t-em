import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { auth } from "@/lib/server/auth";
import { getMyFamily } from "@/lib/server/actions/family";
import { getMyVerificationStatus } from "@/lib/server/actions/email-verification";
import { Wordmark } from "@/components/brand/wordmark";
import { UserMenu } from "@/components/app/user-menu";
import { AppNav } from "@/components/app/app-nav";
import { EmailVerificationBanner } from "@/components/app/email-verification-banner";
import { Button } from "@/components/ui/button";

/**
 * Session is OPTIONAL here now (CLAUDE.md "Misafir modu"): this group hosts
 * both account-only routes (/budgets, /recurring, /family, /settings — still
 * redirected to /login by src/proxy.ts when signed out) and guest-friendly
 * ones (/dashboard, /transactions — deliberately unprotected in proxy.ts).
 * A blanket `redirect("/login")` here would break the guest-friendly routes
 * for exactly the users who are supposed to reach them without an account,
 * so this layout no longer redirects at all — it only renders differently
 * depending on whether a session exists. The proxy is the actual
 * authorization boundary for the account-only routes; nothing in this
 * layout needs to duplicate that.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await auth();
  const t = await getTranslations("app");

  const navLinks = [
    { href: "/dashboard", label: t("nav.dashboard") },
    { href: "/transactions", label: t("nav.transactions") },
  ] as const;

  // Only resolved for a signed-in user — `getMyFamily()`/`getMyVerificationStatus()`
  // both require a session internally anyway (guest-mode users never reach
  // this branch). `getMyFamily` drives `UserMenu`'s "Aile Planı Ayarları"
  // item: with no family, that item opens an explanatory popup instead of
  // navigating to `/family/budgets` (which would otherwise just redirect to
  // `/family`'s onboarding choice). `getMyVerificationStatus` drives whether
  // `EmailVerificationBanner` renders below the header — a small, dedicated
  // query (not bundled into `getMyProfile`) so this shell-level check on
  // EVERY page stays as cheap as possible; see that action's doc comment.
  const [familyResult, verificationResult] = session?.user
    ? await Promise.all([getMyFamily(), getMyVerificationStatus()])
    : [null, null];
  const hasFamily = Boolean(familyResult?.success && familyResult.data !== null);
  const needsEmailVerification = Boolean(
    verificationResult?.success && !verificationResult.data.verified
  );

  return (
    <div className="flex min-h-full flex-1 flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <Wordmark size="sm" />
            <AppNav links={navLinks} />
          </div>
          {session?.user ? (
            <UserMenu
              name={session.user.name ?? t("userMenu.defaultUserName")}
              email={session.user.email ?? ""}
              hasFamily={hasFamily}
            />
          ) : (
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link href="/login">{t("header.signIn")}</Link>}
              />
              <Button
                size="sm"
                nativeButton={false}
                render={<Link href="/register">{t("header.signUp")}</Link>}
              />
            </div>
          )}
        </div>
        {needsEmailVerification ? <EmailVerificationBanner /> : null}
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}
