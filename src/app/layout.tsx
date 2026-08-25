import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display face, used sparingly (wordmark, large ledger figures) — everything
// else in the UI stays on Geist Sans/Mono. See src/app/globals.css for how
// --font-display is wired into the `font-display` utility.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  style: ["normal"],
});

// Brand name ("Bütçem") stays identical in both locales — only the
// descriptive tagline/description is translated.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app.meta");
  return {
    title: {
      default: `Bütçem — ${t("tagline")}`,
      template: "%s · Bütçem",
    },
    description: t("description"),
  };
}

/**
 * `NextIntlClientProvider` set up here (root layout, not per-route-group) is
 * what every `useTranslations` call in a Client Component relies on — no
 * exceptions, including the currently-untranslated `/family/**` tree, which
 * still renders under this same provider (its own strings just stay literal
 * Turkish for now, see CLAUDE.md's "Aile planı" scope note). `locale`/
 * `messages` both come from `src/i18n/request.ts`'s `getRequestConfig` (no
 * URL prefix — cookie/JWT-resolved, see that file's doc comment), so this
 * layout doesn't re-derive either itself.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
