import { Landmark } from "lucide-react";

import { cn } from "@/lib/utils";

const SIZE_STYLES = {
  sm: { mark: "size-6", icon: "size-3.5", text: "text-base" },
  md: { mark: "size-7", icon: "size-4", text: "text-lg" },
  lg: { mark: "size-9", icon: "size-5", text: "text-2xl" },
} as const;

export function Wordmark({
  size = "md",
  tone = "default",
  className,
}: {
  size?: keyof typeof SIZE_STYLES;
  tone?: "default" | "inverted";
  className?: string;
}) {
  const s = SIZE_STYLES[size];
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg",
          s.mark,
          tone === "inverted"
            ? "bg-brand-deep-foreground/10 text-brand-deep-foreground"
            : "bg-brand text-brand-foreground"
        )}
      >
        <Landmark className={s.icon} strokeWidth={2.25} />
      </span>
      <span
        className={cn(
          "font-display font-semibold tracking-tight",
          s.text,
          tone === "inverted" ? "text-brand-deep-foreground" : "text-foreground"
        )}
      >
        Bütçem
      </span>
    </span>
  );
}
