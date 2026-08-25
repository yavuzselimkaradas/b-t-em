import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { NewPasswordForm } from "./new-password-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.newPassword");
  return { title: t("title") };
}

/**
 * Server shell for `NewPasswordForm` — the `token` dynamic segment (the raw
 * value embedded in the emailed reset link, see
 * `password-reset.ts::requestPasswordReset`) is handed straight to the
 * client form, which submits it alongside the new password to
 * `resetPassword`. No server-side validation/consumption happens HERE —
 * that would burn the single-use token on a page LOAD (including a mail
 * client's link-prefetching, or a search-engine/security-scanner crawler
 * following the link) rather than on the person's actual submit, locking
 * them out before they ever see the form.
 */
export default async function ResetPasswordTokenPage(
  props: PageProps<"/reset-password/[token]">
) {
  const { token } = await props.params;
  return <NewPasswordForm token={token} />;
}
