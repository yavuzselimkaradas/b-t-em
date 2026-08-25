"use client";

import { useState, type ComponentType } from "react";
import { Link2, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import { CreateFamilyForm } from "@/components/family/create-family-form";
import { JoinFamilyForm } from "@/components/family/join-family-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Choice = "create" | "join";

const CHOICES: {
  value: Choice;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
}[] = [
  {
    value: "create",
    label: "Aile Planı Oluştur",
    description: "Yeni bir aile planı kur, üyeleri sen davet et.",
    icon: Users,
  },
  {
    value: "join",
    label: "Aile Planına Katıl",
    description: "Sana gönderilen bir davet linkiyle mevcut bir aileye katıl.",
    icon: Link2,
  },
];

/**
 * The no-family entry point on `/family` — a binary choice between starting
 * a new family plan and joining an existing one via a pasted invite link.
 * Replaces the old "always show the create form" state (`CreateFamilyForm`
 * used to be the only option rendered directly): joining no longer strictly
 * requires clicking a link opened from outside the app (e.g. a link shared
 * as plain text, read on another device) — see `join-family-form.tsx`.
 * `/invite/[token]` (opening the link directly) still works exactly as
 * before; this is an additional path to the same `acceptInvite` action.
 *
 * Neither box is pre-selected — a real binary choice, not a default with an
 * alternative tucked away — so the form below only appears once the user
 * has actually picked a path.
 */
export function FamilyOnboardingChoice() {
  const [choice, setChoice] = useState<Choice | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div
        role="radiogroup"
        aria-label="Aile planına başlama şekli"
        className="grid gap-3 sm:grid-cols-2"
      >
        {CHOICES.map(({ value, label, description, icon: Icon }) => {
          const isSelected = choice === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setChoice(value)}
              className={cn(
                "flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                isSelected
                  ? "border-brand/30 bg-brand-soft text-brand-soft-foreground"
                  : "border-border hover:bg-muted"
              )}
            >
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-full",
                  isSelected ? "bg-background/60" : "bg-muted text-muted-foreground"
                )}
              >
                <Icon className="size-4.5" strokeWidth={2.25} />
              </span>
              <span className="font-medium">{label}</span>
              <span
                className={cn(
                  "text-sm",
                  isSelected ? "text-brand-soft-foreground/80" : "text-muted-foreground"
                )}
              >
                {description}
              </span>
            </button>
          );
        })}
      </div>

      {choice ? (
        <Card>
          <CardHeader>
            <CardTitle>{choice === "create" ? "Aile planı oluştur" : "Aile planına katıl"}</CardTitle>
            <CardDescription>
              {choice === "create"
                ? "Aile üyeleriyle ortak bütçe yönetimine başla. Bir isim seç — üyeleri davet etme bir sonraki adımda gelecek."
                : "Katılacağın aile planının davet linkini ya da kodunu yapıştır."}
            </CardDescription>
          </CardHeader>
          <CardContent>{choice === "create" ? <CreateFamilyForm /> : <JoinFamilyForm />}</CardContent>
        </Card>
      ) : null}
    </div>
  );
}
