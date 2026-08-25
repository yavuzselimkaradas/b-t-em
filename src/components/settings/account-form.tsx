"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { updateProfile } from "@/lib/server/actions/settings";
import { updateProfileSchema, type UpdateProfileInput } from "@/lib/validation/settings";
import { FieldError, FormAlert } from "@/components/auth/form-elements";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Same inline-form shape as `create-family-form.tsx` (react-hook-form + Zod
 * resolver, general error via `FormAlert`, field errors via `FieldError`).
 * On success, `router.refresh()` re-runs `/settings`'s Server Component,
 * which re-calls `getMyProfile()` and re-fills the form with the fresh
 * values — no client-side profile state kept here beyond the form itself.
 *
 * NOTE: if `email` changes, the active session JWT still carries the OLD
 * email until the next sign-in (see `updateProfile`'s doc comment in
 * `lib/server/actions/settings.ts`) — this form doesn't attempt to patch
 * `useSession()`'s cached value, `router.refresh()` + the server-fetched
 * `initialProfile` prop is the source of truth for what's rendered here.
 */
export function AccountForm({ initialProfile }: { initialProfile: { name: string; email: string } }) {
  const router = useRouter();
  const t = useTranslations("settings.account");
  const tCommon = useTranslations("common");
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: { name: initialProfile.name, email: initialProfile.email },
  });

  const onSubmit = async (values: UpdateProfileInput) => {
    setFormError(null);
    setSuccessMessage(null);
    try {
      const result = await updateProfile(values);

      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (messages?.[0]) {
              setError(field as keyof UpdateProfileInput, { message: messages[0] });
            }
          }
        }
        return;
      }

      setSuccessMessage(t("success"));
      router.refresh();
    } catch {
      setFormError(tCommon("somethingWrong"));
    }
  };

  // Not just `handleSubmit(onSubmit)`: `onSubmit` only runs once the Zod
  // resolver passes, so a stale success/error message from a PREVIOUS
  // submit would otherwise sit on screen through a subsequent submit that
  // fails client-side validation (e.g. clearing the name field and hitting
  // "Kaydet" again right after a successful save) — misleading, "değişti"
  // shown next to a brand-new "en az 2 karakter olmalı" error. Clearing both
  // synchronously on every submit ATTEMPT, before resolver validation runs,
  // closes that gap.
  const submitHandler = handleSubmit(onSubmit);

  return (
    <form
      onSubmit={(event) => {
        setFormError(null);
        setSuccessMessage(null);
        void submitHandler(event);
      }}
      noValidate
      className="flex flex-col gap-4"
    >
      <FormAlert message={formError} />
      {!formError && successMessage ? (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          {successMessage}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">{t("nameLabel")}</Label>
        <Input
          id="name"
          type="text"
          autoComplete="name"
          aria-invalid={!!errors.name}
          {...register("name")}
        />
        <FieldError message={errors.name?.message} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t("emailLabel")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          aria-invalid={!!errors.email}
          {...register("email")}
        />
        <FieldError message={errors.email?.message} />
      </div>

      <Button type="submit" disabled={isSubmitting} className="self-start">
        {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t("save")}
      </Button>
    </form>
  );
}
