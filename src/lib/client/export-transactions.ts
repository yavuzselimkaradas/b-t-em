// Client-only Excel/PDF export — deliberately generated entirely in the
// browser, not on the server. Reason: guest-mode transactions only ever
// exist in `localStorage` (see guest-store.ts), so a server Route Handler
// could never export them; building the file from `TransactionViewModel[]`
// (already the shared shape both account and guest data conform to — see
// transaction-view-model.ts) means the exact same export code works for
// both, with no source-specific branching here at all.
//
// Both `exceljs` and `jspdf`/`jspdf-autotable` are dynamically imported
// inside each function (not at module top-level) — they're only ever
// needed the moment a user clicks a download button, so there's no reason
// to ship them in the initial page bundle.
import type { TransactionViewModel } from "@/lib/client/transaction-view-model";
import { formatAmount, type CurrencyCode } from "@/lib/domain/currency";
import Decimal from "decimal.js";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC", // dates are stored as UTC midnight — see transaction-form.tsx
});

export interface ExportMeta {
  /** Human-readable label for the active filter, e.g. "Ağustos 2026" or
   * "Tüm işlemler" — shown as a heading inside the file. */
  periodLabel: string;
  /** File name WITHOUT extension — the caller appends ".xlsx"/".pdf". */
  fileNameBase: string;
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on a delay, not immediately — some browsers (notably Safari)
  // cancel the download if the object URL is revoked before the click's
  // navigation has actually started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function computeTotals(transactions: TransactionViewModel[]) {
  let totalIncome = new Decimal(0);
  let totalExpense = new Decimal(0);
  for (const t of transactions) {
    const amount = new Decimal(t.amount);
    if (t.type === "INCOME") totalIncome = totalIncome.plus(amount);
    else totalExpense = totalExpense.plus(amount);
  }
  return { totalIncome, totalExpense, net: totalIncome.minus(totalExpense) };
}

/** Currency to format totals/amounts in when a filtered range mixes
 * currencies (rare, but possible) — falls back to the first row's
 * currency, same convention `CategoryPieChart`/`YearPickerPanel` use. */
function resolveCurrency(transactions: TransactionViewModel[]): CurrencyCode {
  return (transactions[0]?.currency as CurrencyCode | undefined) ?? "TRY";
}

export async function exportTransactionsToExcel(
  transactions: TransactionViewModel[],
  meta: ExportMeta
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const currency = resolveCurrency(transactions);
  const { totalIncome, totalExpense, net } = computeTotals(transactions);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Bütçem";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("İşlemler");

  sheet.mergeCells("A1:F1");
  sheet.getCell("A1").value = `Bütçem — ${meta.periodLabel}`;
  sheet.getCell("A1").font = { bold: true, size: 14 };

  sheet.getCell("A3").value = "Toplam Gelir";
  sheet.getCell("B3").value = totalIncome.toNumber();
  sheet.getCell("A4").value = "Toplam Gider";
  sheet.getCell("B4").value = totalExpense.toNumber();
  sheet.getCell("A5").value = "Net";
  sheet.getCell("B5").value = net.toNumber();
  for (const row of [3, 4, 5]) {
    sheet.getCell(`A${row}`).font = { bold: true };
    sheet.getCell(`B${row}`).numFmt = `#,##0.00 "${currency}"`;
  }

  const headerRow = sheet.getRow(7);
  headerRow.values = ["Tarih", "Tür", "Kategori", "Açıklama", "Tutar", "Para Birimi"];
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0EA" } };
  });

  transactions.forEach((t, index) => {
    const row = sheet.getRow(8 + index);
    row.values = [
      dateFormatter.format(new Date(t.date)),
      t.type === "INCOME" ? "Gelir" : "Gider",
      t.category.name,
      t.description ?? "",
      new Decimal(t.amount).toNumber(),
      t.currency,
    ];
    row.getCell(5).numFmt = "#,##0.00";
  });

  sheet.columns = [
    { width: 12 },
    { width: 10 },
    { width: 20 },
    { width: 32 },
    { width: 14 },
    { width: 12 },
  ];

  const buffer = await workbook.xlsx.writeBuffer();
  triggerDownload(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${meta.fileNameBase}.xlsx`
  );
}

export async function exportTransactionsToPdf(
  transactions: TransactionViewModel[],
  meta: ExportMeta
): Promise<void> {
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");
  const { registerTurkishFont } = await import("@/lib/client/fonts/register-pdf-fonts");
  const currency = resolveCurrency(transactions);
  const { totalIncome, totalExpense, net } = computeTotals(transactions);

  const doc = new jsPDF({ orientation: "portrait", unit: "pt" });
  // jsPDF's built-in fonts have no Turkish (ğ ş ı İ Ğ Ş ü ö ç Ü Ö Ç) or Lira
  // (₺) glyphs — see register-pdf-fonts.ts. Every `doc.text(...)` call below
  // must explicitly select "Roboto" (registering it doesn't change the
  // active font on its own), and autoTable needs `font: "Roboto"` in its
  // own `styles`/`headStyles` — it doesn't inherit `doc.setFont(...)`.
  registerTurkishFont(doc);

  doc.setFont("Roboto", "bold");
  doc.setFontSize(16);
  doc.text("Bütçem", 40, 40);
  doc.setFont("Roboto", "normal");
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text(meta.periodLabel, 40, 58);

  doc.setFontSize(10);
  doc.setTextColor(20);
  doc.text(`Toplam Gelir: ${formatAmount(totalIncome, currency)}`, 40, 82);
  doc.text(`Toplam Gider: ${formatAmount(totalExpense, currency)}`, 40, 98);
  doc.text(`Net: ${formatAmount(net, currency)}`, 40, 114);

  autoTable(doc, {
    startY: 132,
    head: [["Tarih", "Tür", "Kategori", "Açıklama", "Tutar"]],
    body: transactions.map((t) => [
      dateFormatter.format(new Date(t.date)),
      t.type === "INCOME" ? "Gelir" : "Gider",
      t.category.name,
      t.description ?? "",
      `${t.type === "INCOME" ? "+" : "-"}${formatAmount(t.amount, t.currency as CurrencyCode)}`,
    ]),
    styles: { font: "Roboto", fontStyle: "normal", fontSize: 9, cellPadding: 5 },
    headStyles: { font: "Roboto", fontStyle: "bold", fillColor: [30, 90, 69] }, // brand forest green
    columnStyles: { 4: { halign: "right" } },
  });

  doc.save(`${meta.fileNameBase}.pdf`);
}
