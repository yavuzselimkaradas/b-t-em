// UI-only category → icon/color mapping. Deliberately NOT in lib/domain:
// it renders lucide-react components, a web-specific icon set the future
// React Native client won't share (see CLAUDE.md — lib/domain stays
// framework-independent). Mobile will need its own version of this file
// with its own icon library, reusing only the *category names / hashing
// idea*, not this code.
import {
  Banknote,
  Building2,
  Car,
  Fuel,
  GraduationCap,
  HeartPulse,
  Home,
  PiggyBank,
  Plane,
  Popcorn,
  ShoppingCart,
  Sparkles,
  Tag,
  TrendingDown,
  TrendingUp,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import type { Category, TransactionType } from "@prisma/client";

/**
 * Known seed default category names (prisma/seed.ts) mapped to a specific,
 * recognizable icon. `Category.icon`/`Category.color` exist in the schema
 * for a future per-category picker (Phase 4), but are `null` for every
 * seeded row today — this table is what actually renders until then.
 * Unknown / future / personal category names fall through to the
 * type-based default below, so nothing ever renders iconless.
 */
const ICON_BY_NAME: Record<string, LucideIcon> = {
  "Maaş": Banknote,
  "Diğer Gelir": PiggyBank,
  "Market": ShoppingCart,
  "Kira": Home,
  "Ulaşım": Car,
  "Eğlence": Popcorn,
  "Diğer Gider": Tag,
  // A few plausible future/personal categories, kept ready so this table
  // doesn't need to grow the moment Phase 4 CRUD ships.
  "Yakıt": Fuel,
  "Sağlık": HeartPulse,
  "Eğitim": GraduationCap,
  "Seyahat": Plane,
  "Restoran": Utensils,
  "Fatura": Building2,
};

/**
 * Fixed accent palette for category chips, deliberately excluding green and
 * red — those are reserved for the income/expense signal on the amount
 * column (proje dokümanı §8) and must never be reused for a category, or
 * "this chip is green" would be misread as "this is income". Each entry is
 * a light/dark-safe Tailwind pair.
 */
const CHIP_PALETTE = [
  { bg: "bg-amber-100 dark:bg-amber-500/15", fg: "text-amber-700 dark:text-amber-300" },
  { bg: "bg-sky-100 dark:bg-sky-500/15", fg: "text-sky-700 dark:text-sky-300" },
  { bg: "bg-violet-100 dark:bg-violet-500/15", fg: "text-violet-700 dark:text-violet-300" },
  { bg: "bg-orange-100 dark:bg-orange-500/15", fg: "text-orange-700 dark:text-orange-300" },
  { bg: "bg-indigo-100 dark:bg-indigo-500/15", fg: "text-indigo-700 dark:text-indigo-300" },
  { bg: "bg-fuchsia-100 dark:bg-fuchsia-500/15", fg: "text-fuchsia-700 dark:text-fuchsia-300" },
] as const;

/** Cheap, stable string hash — same category always lands on the same chip
 * color across renders/sessions, without needing a stored `color` value. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Hex counterparts of `CHIP_PALETTE`, same order/index, same excluded-
 * green/red rule — for contexts that need an actual paintable color instead
 * of a Tailwind class pair (SVG `fill`, e.g. the category pie chart), where
 * a utility class can't be read back out as a color value. Picked at the
 * -500/-600 step: readable as a small filled shape on both the light and
 * dark `--card` surface, unlike the -100/500-at-15%-opacity chip
 * background, which is far too faint to fill a chart wedge with.
 */
const CHIP_HEX = [
  "#d97706", // amber-600
  "#0284c7", // sky-600
  "#7c3aed", // violet-600
  "#ea580c", // orange-600
  "#4f46e5", // indigo-600
  "#c026d3", // fuchsia-600
] as const;

/**
 * Resolves the fill color for a category in a chart context (e.g.
 * `CategoryPieChart`). Same precedence and hashing as `getCategoryVisual`'s
 * chip color — a category always lands on the same hue in the table chip
 * and in a chart — but returns a hex string instead of Tailwind classes.
 */
export function getCategoryChartColor(category: Pick<Category, "id">): string {
  return CHIP_HEX[hashString(category.id) % CHIP_HEX.length];
}

export interface CategoryVisual {
  icon: LucideIcon;
  bg: string;
  fg: string;
}

/**
 * Resolves the icon + color chip for a category. Icon: `Category.icon` name
 * (once Phase 4 lets users set one) > known default-name lookup > a
 * generic income/expense icon. Color: hashed from the category id into the
 * fixed palette above — deterministic, and never green/red.
 */
export function getCategoryVisual(
  category: Pick<Category, "id" | "name" | "icon" | "type">
): CategoryVisual {
  const icon = ICON_BY_NAME[category.name] ?? defaultIconForType(category.type);
  const palette = CHIP_PALETTE[hashString(category.id) % CHIP_PALETTE.length];
  return { icon, ...palette };
}

function defaultIconForType(type: TransactionType): LucideIcon {
  return type === "INCOME" ? TrendingUp : TrendingDown;
}

/** Small "unknown category" fallback for a transaction whose category
 * relation couldn't be resolved (should not happen given the FK, but keeps
 * the row renderer total). */
export const UNKNOWN_CATEGORY_VISUAL: CategoryVisual = {
  icon: Sparkles,
  bg: "bg-muted",
  fg: "text-muted-foreground",
};
