import type { jsPDF } from "jspdf";

import { ROBOTO_REGULAR_TTF_BASE64 } from "@/lib/client/fonts/roboto-regular-ttf-base64";
import { ROBOTO_BOLD_TTF_BASE64 } from "@/lib/client/fonts/roboto-bold-ttf-base64";

/**
 * Registers a Turkish-capable font ("Roboto") on a jsPDF document and makes
 * it the active font. jsPDF's built-in fonts (helvetica/times/courier — the
 * 14 standard PDF fonts) use WinAnsi encoding, which has NO Turkish
 * characters (ğ ş ı İ Ğ Ş) and no Lira sign (₺) — those render as missing
 * glyphs/tofu boxes. Embedding a real Unicode TTF is the only fix; there's
 * no jsPDF setting that makes the standard fonts support them.
 *
 * Call this once per document, right after `new jsPDF(...)`, before any
 * `doc.text(...)`/`autoTable(...)` calls. Every place text is drawn must
 * then explicitly set `font: "Roboto"` (autoTable's `styles`/`headStyles`)
 * or call `doc.setFont("Roboto", ...)` — jsPDF does NOT default new content
 * to a just-registered font, it stays on "helvetica" unless told otherwise.
 */
export function registerTurkishFont(doc: jsPDF): void {
  doc.addFileToVFS("Roboto-Regular.ttf", ROBOTO_REGULAR_TTF_BASE64);
  doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
  doc.addFileToVFS("Roboto-Bold.ttf", ROBOTO_BOLD_TTF_BASE64);
  doc.addFont("Roboto-Bold.ttf", "Roboto", "bold");
  doc.setFont("Roboto", "normal");
}
