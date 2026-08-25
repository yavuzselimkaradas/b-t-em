import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.login");
  return { title: t("title") };
}

/**
 * Only same-origin relative paths are honored — guards against an
 * open-redirect via a crafted `?callbackUrl=`.
 *
 * A plain `startsWith("//")` check is not enough: the WHATWG URL parser
 * (which both browsers and Next.js's client-side navigation use) treats a
 * leading backslash the same as a leading slash, so `/\evil.com` also
 * resolves to `https://evil.com/`. We defer to that same parser — resolving
 * `raw` against a dummy same-origin base and rejecting anything whose
 * origin changed — instead of trying to out-guess it with more string
 * blocklisting. The explicit prefix/backslash checks stay as a
 * belt-and-suspenders layer in case `raw` is ever something `URL` parses
 * more leniently than expected.
 */
function safeCallbackUrl(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const FALLBACK = "/dashboard";

  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return FALLBACK;
  }

  try {
    const resolved = new URL(raw, "http://internal.invalid");
    if (resolved.origin !== "http://internal.invalid") {
      return FALLBACK;
    }
  } catch {
    return FALLBACK;
  }

  return raw;
}

export default async function LoginPage(props: PageProps<"/login">) {
  const searchParams = await props.searchParams;
  const callbackUrl = safeCallbackUrl(searchParams.callbackUrl);

  return <LoginForm callbackUrl={callbackUrl} />;
}
