import Link from "next/link";

import { cn } from "@/lib/utils";

interface PlanSwitcherProps {
  /** Which side of the switcher reflects the page it's rendered on — the
   * caller (transactions-view.tsx, family/page.tsx, family/dashboard/page.tsx)
   * already knows this statically, no route-sniffing needed here. */
  active: "individual" | "family";
  /** Optional label overrides — default to the literal Turkish wording so
   * `family/page.tsx`/`family/dashboard/page.tsx` (out of scope this round,
   * see CLAUDE.md "Aile planı") render unchanged with no caller update
   * needed. `transactions-view.tsx` (in scope) passes translated labels via
   * `useTranslations` instead of this component calling the hook itself —
   * keeps this a framework-i18n-agnostic default rather than forcing every
   * caller through next-intl. */
  individualLabel?: string;
  familyLabel?: string;
}

const SEGMENT_ACTIVE_CLASSES =
  "rounded-[7px] bg-background px-2.5 py-1 text-sm font-medium text-foreground shadow-sm ring-1 ring-foreground/10";
const SEGMENT_LINK_CLASSES =
  "rounded-[7px] px-2.5 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/**
 * "Bireysel Plan / Aile Planı" segmented switcher — shared across
 * `/transactions`, `/family`, and `/family/dashboard` so moving between an
 * individual and a family view feels like switching a tab within the same
 * screen, not navigating to an unrelated page. Originally lived inline in
 * `transactions-view.tsx` (the only page with a working family destination
 * at the time); extracted here once `/family`/`/family/dashboard` became
 * real pages that needed the same switcher pointed the other way.
 *
 * Both segments carry a plain destination label ("Bireysel Plan"/"Aile
 * Planı"), not a call-to-action phrasing like "Aile Planına Geç" — now that
 * this renders on every page in the switch, it reads as a persistent tab
 * strip rather than a one-off "go here" link.
 */
export function PlanSwitcher({
  active,
  individualLabel = "Bireysel Plan",
  familyLabel = "Aile Planı",
}: PlanSwitcherProps) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5">
      {active === "individual" ? (
        <span aria-current="page" className={SEGMENT_ACTIVE_CLASSES}>
          {individualLabel}
        </span>
      ) : (
        <Link href="/transactions" className={cn(SEGMENT_LINK_CLASSES)}>
          {individualLabel}
        </Link>
      )}
      {active === "family" ? (
        <span aria-current="page" className={SEGMENT_ACTIVE_CLASSES}>
          {familyLabel}
        </span>
      ) : (
        <Link href="/family" className={cn(SEGMENT_LINK_CLASSES)}>
          {familyLabel}
        </Link>
      )}
    </div>
  );
}
