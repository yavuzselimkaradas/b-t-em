"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { CURRENCY_OPTIONS } from "@/lib/domain/currency";
import { updatePreferences } from "@/lib/server/actions/settings";
import {
  updatePreferencesSchema,
  type UpdatePreferencesInput,
} from "@/lib/validation/settings";
import { FieldError, FormAlert } from "@/components/auth/form-elements";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const LANGUAGE_OPTIONS: { value: UpdatePreferencesInput["preferredLanguage"]; label: string }[] = [
  { value: "tr", label: "Türkçe" },
  { value: "en", label: "English" },
];

/**
 * Same inline-form shape as `AccountForm`/`PasswordForm`. Unlike those two,
 * both fields here are `Select`s (Controller-wrapped, same pattern
 * `transaction-form.tsx` uses for its currency field) rather than free-text
 * `Input`s — there's nothing to type, only choose from a fixed enum.
 */
export function PreferencesForm({
  initialPreferences,
}: {
  initialPreferences: UpdatePreferencesInput;
}) {
  const router = useRouter();
  const t = useTranslations("settings.preferences");
  const tCommon = useTranslations("common");
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<UpdatePreferencesInput>({
    resolver: zodResolver(updatePreferencesSchema),
    defaultValues: initialPreferences,
  });

  const onSubmit = async (values: UpdatePreferencesInput) => {
    setFormError(null);
    setSuccessMessage(null);
    try {
      const result = await updatePreferences(values);

      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (messages?.[0]) {
              setError(field as keyof UpdatePreferencesInput, { message: messages[0] });
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

  // See the same wrapper in `account-form.tsx` for why this isn't just
  // `handleSubmit(onSubmit)` — clears a stale success/error message on every
  // submit ATTEMPT, before the Zod resolver runs.
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

      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          control={control}
          name="preferredLanguage"
          render={({ field }) => (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preferredLanguage">{t("languageLabel")}</Label>
              <Select value={field.value} onValueChange={field.onChange} name={field.name}>
                <SelectTrigger
                  id="preferredLanguage"
                  className="w-full"
                  aria-invalid={!!errors.preferredLanguage}
                >
                  {/* Render-prop, not a bare `<SelectValue />`: Base UI's
                      `<Select.Value>` shows the raw stored value ("tr")
                      until the popup has opened once — same documented
                      quirk/fix as the category select in
                      transaction-form.tsx. */}
                  <SelectValue>
                    {(value: string | null) =>
                      LANGUAGE_OPTIONS.find((o) => o.value === value)?.label ?? t("languagePlaceholder")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.preferredLanguage?.message} />
            </div>
          )}
        />

        <Controller
          control={control}
          name="preferredCurrency"
          render={({ field }) => (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preferredCurrency">{t("currencyLabel")}</Label>
              <Select value={field.value} onValueChange={field.onChange} name={field.name}>
                <SelectTrigger
                  id="preferredCurrency"
                  className="w-full"
                  aria-invalid={!!errors.preferredCurrency}
                >
                  {/* Same render-prop fix as the language select above. */}
                  <SelectValue>
                    {(value: string | null) =>
                      CURRENCY_OPTIONS.find((o) => o.value === value)?.label ?? t("currencyPlaceholder")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CURRENCY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={errors.preferredCurrency?.message} />
            </div>
          )}
        />
      </div>

      <Button type="submit" disabled={isSubmitting} className="self-start">
        {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t("save")}
      </Button>
    </form>
  );
}
