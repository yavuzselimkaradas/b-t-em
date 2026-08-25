"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Info, Plus, Trash2 } from "lucide-react";
import { useLocale } from "next-intl";

import { cn } from "@/lib/utils";
import {
  deleteCustomMonthlyPreset,
  listCustomMonthlyPresets,
  resolveCustomMonthlyRange,
  saveCustomMonthlyPreset,
  type CustomMonthlyPreset,
} from "@/lib/client/custom-monthly-presets";
import { toIntlLocale } from "@/lib/client/intl-locale";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import type { Locale } from "@/i18n/locale";
import type { TransactionFilterState } from "@/components/transactions/transaction-filters-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function formatRangeLabel(from: string, to: string, intlLocale: string): string {
  const dayMonthFormatter = new Intl.DateTimeFormat(intlLocale, { day: "2-digit", month: "short" });
  const fromLabel = dayMonthFormatter.format(new Date(`${from}T00:00:00`));
  const toLabel = dayMonthFormatter.format(new Date(`${to}T00:00:00`));
  return `${fromLabel} – ${toLabel}`;
}

interface CustomMonthlyRangeButtonProps {
  filters: TransactionFilterState;
  onChange: (patch: Partial<TransactionFilterState>) => void;
  /** `true` on `/transactions` (tracks the active locale, including date
   * formatting), omitted/`false` on `/family/dashboard` (stays pinned to
   * Turkish) — see lib/client/use-scoped-translations.ts's doc comment. */
  translate?: boolean;
}

/**
 * "Kişiselleştirilmiş aylık aralık" — replaces the old single inline
 * anchor-day input with a managed, named, multi-preset list (e.g. "Maaş
 * dönemi" = ayın 15'i, "Kira dönemi" = ayın 1'i), each independently
 * saved in `localStorage` (see custom-monthly-presets.ts). Applying a
 * preset whose day doesn't exist in the resolved cycle's month (30 in
 * Şubat, 31 in Eylül, …) shows an explanatory confirmation before
 * applying — never a silent substitution — per the product's
 * "her durumu kullanıcıya söyle" requirement.
 */
export function CustomMonthlyRangeButton({
  filters,
  onChange,
  translate = false,
}: CustomMonthlyRangeButtonProps) {
  const t = useScopedTranslations("transactions.customMonthly", translate);
  const tCommon = useScopedTranslations("common", translate);
  const activeLocale = useLocale() as Locale;
  const intlLocale = toIntlLocale(translate ? activeLocale : "tr");
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<CustomMonthlyPreset[]>([]);
  const [dayDraft, setDayDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [pendingFallback, setPendingFallback] = useState<{
    preset: CustomMonthlyPreset;
    from: string;
    to: string;
    fallbackDetails: { day: number; targetMonthLabel: string; fallbackDateLabel: string };
  } | null>(null);

  // localStorage only exists client-side — loaded once on mount (not
  // computed during render) so the server-rendered HTML and the client's
  // first render both start from an empty list, avoiding a hydration
  // mismatch. This is a one-time sync from a browser-only store, not a
  // subscription to something that changes from outside this component, so
  // the effect+setState pattern here is intentional rather than something
  // `useState(lazyInit)` or `useSyncExternalStore` would meaningfully improve.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see comment above the effect
    setPresets(listCustomMonthlyPresets());
  }, []);

  const resolvedByPresetId = new Map(
    presets.map((preset) => [preset.id, resolveCustomMonthlyRange(preset.day, new Date(), intlLocale)])
  );
  const isPresetActive = (preset: CustomMonthlyPreset) => {
    const resolved = resolvedByPresetId.get(preset.id);
    return Boolean(resolved && filters.from === resolved.from && filters.to === resolved.to);
  };
  const isAnyPresetActive = presets.some(isPresetActive);

  const applyRange = (from: string, to: string) => {
    onChange({ from, to });
    setPendingFallback(null);
    setOpen(false);
  };

  const handleApply = (preset: CustomMonthlyPreset) => {
    const resolved = resolveCustomMonthlyRange(preset.day, new Date(), intlLocale);
    if (resolved.fallbackApplied && resolved.fallbackDetails) {
      setPendingFallback({
        preset,
        from: resolved.from,
        to: resolved.to,
        fallbackDetails: resolved.fallbackDetails,
      });
      return;
    }
    applyRange(resolved.from, resolved.to);
  };

  const handleAdd = () => {
    const day = Number.parseInt(dayDraft, 10);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      setAddError(t("dayRangeError"));
      return;
    }
    const preset = saveCustomMonthlyPreset({ day, label: labelDraft });
    setPresets((prev) => [...prev, preset]);
    setDayDraft("");
    setLabelDraft("");
    setAddError(null);
  };

  const handleDelete = (id: string) => {
    deleteCustomMonthlyPreset(id);
    setPresets((prev) => prev.filter((preset) => preset.id !== id));
  };

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={isAnyPresetActive ? "default" : "outline"}
        onClick={() => setOpen(true)}
      >
        <CalendarClock className="size-3.5" />
        {t("trigger")}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPendingFallback(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
        {pendingFallback ? (
          <>
            <DialogHeader>
              <div className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <Info className="size-4.5" strokeWidth={2.25} />
              </div>
              <DialogTitle>{t("fallbackTitle")}</DialogTitle>
              <DialogDescription>
                {t("explanation", {
                  day: pendingFallback.fallbackDetails.day,
                  targetMonthLabel: pendingFallback.fallbackDetails.targetMonthLabel,
                  fallbackDateLabel: pendingFallback.fallbackDetails.fallbackDateLabel,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPendingFallback(null)}>
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => applyRange(pendingFallback.from, pendingFallback.to)}
              >
                {t("fallbackAcknowledge")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("dialogTitle")}</DialogTitle>
              <DialogDescription>{t("dialogDescription")}</DialogDescription>
            </DialogHeader>

            {presets.length > 0 ? (
              <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                {presets.map((preset) => {
                  const resolved = resolvedByPresetId.get(preset.id);
                  const active = isPresetActive(preset);
                  return (
                    <li key={preset.id}>
                      <div
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-2.5 py-2 ring-1 ring-foreground/10",
                          active ? "bg-accent" : "bg-transparent"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => handleApply(preset)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="truncate text-sm font-medium text-foreground">
                            {preset.label || t("unnamedPreset", { day: preset.day })}
                          </p>
                          {resolved ? (
                            <p className="num-tabular text-xs text-muted-foreground">
                              {formatRangeLabel(resolved.from, resolved.to, intlLocale)}
                              {resolved.fallbackApplied ? ` · ${t("fallbackHint")}` : ""}
                            </p>
                          ) : null}
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("deleteAria")}
                          onClick={() => handleDelete(preset.id)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("empty")}</p>
            )}

            <div className="flex flex-col gap-2 rounded-lg bg-muted/60 p-3">
              <Label className="text-xs text-muted-foreground">{t("addNewLabel")}</Label>
              <div className="flex items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="preset-day" className="sr-only">
                    {t("dayLabel")}
                  </Label>
                  <Input
                    id="preset-day"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={31}
                    placeholder={t("dayPlaceholder")}
                    value={dayDraft}
                    onChange={(event) => setDayDraft(event.target.value)}
                    className="w-24"
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Label htmlFor="preset-label" className="sr-only">
                    {t("nameLabelOptional")}
                  </Label>
                  <Input
                    id="preset-label"
                    placeholder={t("namePlaceholder")}
                    value={labelDraft}
                    onChange={(event) => setLabelDraft(event.target.value)}
                  />
                </div>
                <Button type="button" size="icon" onClick={handleAdd} aria-label={t("addAria")}>
                  <Plus className="size-4" />
                </Button>
              </div>
              {addError ? <p className="text-xs text-destructive">{addError}</p> : null}
            </div>
          </>
        )}
        </DialogContent>
      </Dialog>
    </>
  );
}
