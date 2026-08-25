"use client";

import { useState } from "react";
import { AlertCircle, FileSpreadsheet, FileText, Loader2 } from "lucide-react";

import type { TransactionExportResult } from "@/lib/client/transaction-view-model";
import type { TransactionFilterState } from "@/components/transactions/transaction-filters-bar";
import {
  exportTransactionsToExcel,
  exportTransactionsToPdf,
} from "@/lib/client/export-transactions";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import { Button } from "@/components/ui/button";

interface ExportButtonsProps {
  filters: TransactionFilterState;
  /** Either `source.exportAll` (lib/client/transactions-source.ts, the
   * account or guest one) on the individual page, or `(filters) =>
   * exportFamilyTransactions(familyId, filters)` on the family dashboard —
   * this component only needs the full (unpaginated) matching-rows fetch,
   * not the rest of `TransactionSource`. */
  onExportAll: (filters: unknown) => Promise<TransactionExportResult>;
  /** `true` on `/transactions` (tracks the active locale), omitted/`false`
   * on `/family/dashboard` (stays pinned to Turkish) — see
   * lib/client/use-scoped-translations.ts's doc comment. */
  translate?: boolean;
}

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC", // dates are stored/filtered as UTC midnight — see transaction-form.tsx
});

/** Human-readable summary of the active filter, shown as a heading inside
 * the exported file (e.g. "01.08.2026 – 12.08.2026 · Gider"). Deliberately
 * NOT localized — this text (and the rest of lib/client/export-transactions.ts's
 * Excel/PDF content: column headers, "Gelir"/"Gider" rows, etc.) is baked
 * into the DOWNLOADED FILE, not rendered on screen, and localizing a
 * generated document's content is a larger scope than this pass's "sayfa/
 * bileşenleri çevir" brief covers — see the final report's follow-up note. */
function buildPeriodLabel(filters: TransactionFilterState): string {
  const parts: string[] = [];
  if (filters.from || filters.to) {
    const from = filters.from
      ? dateFormatter.format(new Date(`${filters.from}T00:00:00Z`))
      : "başlangıç";
    const to = filters.to ? dateFormatter.format(new Date(`${filters.to}T00:00:00Z`)) : "bugün";
    parts.push(`${from} – ${to}`);
  }
  if (filters.type) parts.push(filters.type === "INCOME" ? "Gelir" : "Gider");
  return parts.length > 0 ? parts.join(" · ") : "Tüm işlemler";
}

function buildFileNameBase(filters: TransactionFilterState): string {
  if (filters.from && filters.to) return `butcem-islemler-${filters.from}_${filters.to}`;
  const today = new Date().toISOString().slice(0, 10);
  return `butcem-islemler-${today}`;
}

type ExportKind = "excel" | "pdf";

/**
 * Bottom-of-page Excel/PDF export buttons — exports whatever the CURRENT
 * filter matches (not just the current page's 20 rows, see
 * `TransactionSource.exportAll`'s doc comment), so "download what I'm
 * looking at" holds even when the filtered range spans many pages.
 */
export function ExportButtons({ filters, onExportAll, translate = false }: ExportButtonsProps) {
  const t = useScopedTranslations("transactions.export", translate);
  const [pending, setPending] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runExport = async (kind: ExportKind) => {
    setPending(kind);
    setError(null);
    try {
      const result = await onExportAll({
        type: filters.type || undefined,
        categoryId: filters.categoryId || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      if (result.data.length === 0) {
        setError(t("noData"));
        return;
      }

      const meta = { periodLabel: buildPeriodLabel(filters), fileNameBase: buildFileNameBase(filters) };
      if (kind === "excel") {
        await exportTransactionsToExcel(result.data, meta);
      } else {
        await exportTransactionsToPdf(result.data, meta);
      }

      if (result.truncated) {
        setError(t("truncated"));
      }
    } catch (error) {
      console.error("[ExportButtons] export failed", error);
      setError(t("failed"));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      <div className="flex flex-wrap items-center gap-2">
        {error ? (
          <span role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            {error}
          </span>
        ) : null}
        {/* `size="lg"`, same as the page's "Yeni işlem" CTA above, so these
            read as proper actions rather than a quiet utility link. Excel
            uses the app's income-green soft pairing (`--income`/
            `--income-soft`, see globals.css) and PDF the existing
            `destructive` button variant (expense-red) — both are the
            palette's own pre-paired, theme-safe combinations (unlike a raw
            `bg-income`/`bg-destructive` fill with hardcoded white text,
            which would lose contrast in dark mode, where those tokens are
            deliberately light/bright for use as text-on-dark, not as a
            solid fill). No income/expense meaning is implied here — just
            two already-on-brand colors to tell the buttons apart. */}
        <Button
          type="button"
          size="lg"
          disabled={pending !== null}
          onClick={() => runExport("excel")}
          className="bg-income-soft text-income hover:bg-income-soft/70"
        >
          {pending === "excel" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileSpreadsheet className="size-4" />
          )}
          {t("excel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="lg"
          disabled={pending !== null}
          onClick={() => runExport("pdf")}
        >
          {pending === "pdf" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileText className="size-4" />
          )}
          {t("pdf")}
        </Button>
      </div>
    </div>
  );
}
