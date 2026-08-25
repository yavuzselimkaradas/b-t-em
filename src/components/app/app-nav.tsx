"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface AppNavProps {
  links: readonly { href: string; label: string }[];
}

/** Top-bar primary navigation for the signed-in app shell. Highlights the
 * active section by path prefix, so e.g. `/transactions?type=INCOME` still
 * reads "İşlemler" as active. */
export function AppNav({ links }: AppNavProps) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-0.5 sm:gap-1">
      {links.map((link) => {
        const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-lg px-2 py-1.5 text-sm font-medium transition-colors sm:px-2.5",
              isActive
                ? "bg-brand-soft text-brand-soft-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
