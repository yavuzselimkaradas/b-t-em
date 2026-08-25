"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";

import { createFamily } from "@/lib/server/actions/family";
import { createFamilySchema, type CreateFamilyInput } from "@/lib/validation/family";
import { FieldError, FormAlert } from "@/components/auth/form-elements";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Same inline-form shape as `register-form.tsx` (react-hook-form + Zod
 * resolver, general error via `FormAlert`, field errors via `FieldError`) —
 * not a `Dialog` like `transaction-form.tsx`, since there's no existing
 * family view to layer a modal over here. On success, `router.refresh()`
 * re-runs the server component (`family/page.tsx`), which re-calls
 * `getMyFamily()` and swaps this form out for the real member view — no
 * client-side family state to manage here at all.
 */
export function CreateFamilyForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateFamilyInput>({
    resolver: zodResolver(createFamilySchema),
    defaultValues: { name: "" },
  });

  const onSubmit = async (values: CreateFamilyInput) => {
    setFormError(null);
    try {
      const result = await createFamily(values.name);

      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (messages?.[0]) {
              setError(field as keyof CreateFamilyInput, { message: messages[0] });
            }
          }
        }
        return;
      }

      router.refresh();
    } catch {
      setFormError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
      <FormAlert message={formError} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Aile adı</Label>
        <Input
          id="name"
          type="text"
          autoComplete="off"
          placeholder="Örn. Karadaş Ailesi"
          aria-invalid={!!errors.name}
          {...register("name")}
        />
        <FieldError message={errors.name?.message} />
      </div>

      <Button type="submit" size="lg" disabled={isSubmitting} className="self-start">
        {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
        Aile oluştur
      </Button>
    </form>
  );
}
