import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { RegisterForm } from "./register-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.register");
  return { title: t("metaTitle") };
}

export default function RegisterPage() {
  return <RegisterForm />;
}
