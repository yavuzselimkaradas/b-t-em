"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Info, LogOut, Settings, Users, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase()).join("");
  return letters || "?";
}

interface UserMenuProps {
  name: string;
  email: string;
  /** Whether the signed-in user currently belongs to a family (owner or
   * member) — resolved server-side in (app)/layout.tsx via `getMyFamily()`.
   * Gates "Aile Planı Ayarları": with no family, that item can't usefully
   * navigate anywhere (`/family/budgets` would just redirect to `/family`'s
   * onboarding choice), so it opens an explanatory popup instead. */
  hasFamily: boolean;
}

export function UserMenu({ name, email, hasFamily }: UserMenuProps) {
  const router = useRouter();
  const t = useTranslations("app.userMenu");
  const [isNoFamilyDialogOpen, setIsNoFamilyDialogOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut({ redirect: false });
    router.push("/login");
    router.refresh();
  };

  function handleFamilySettingsClick() {
    if (hasFamily) {
      router.push("/family/budgets");
    } else {
      setIsNoFamilyDialogOpen(true);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-1.5 pr-2.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-muted">
          <Avatar size="sm">
            <AvatarFallback>{initials(name)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-32 truncate sm:inline">{name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {/* Base UI's `Menu.GroupLabel` (`DropdownMenuLabel`) needs a
              `Menu.Group`/`Menu.RadioGroup` ancestor providing its group
              context — it can't sit as a plain child of `DropdownMenuContent`
              on its own (see the same note in trend-view.tsx's granularity
              menu, the other place this app uses a bare label). */}
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex flex-col gap-0.5 px-1.5 py-1.5">
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/settings")}>
            <Settings className="size-4" />
            {t("settings")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/budgets")}>
            <Wallet className="size-4" />
            {t("individualPlan")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleFamilySettingsClick}>
            <Users className="size-4" />
            {t("familyPlan")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
            <LogOut className="size-4" />
            {t("signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={isNoFamilyDialogOpen} onOpenChange={setIsNoFamilyDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="flex size-9 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
              <Info className="size-4.5" strokeWidth={2.25} />
            </div>
            <DialogTitle>{t("familyRequiredTitle")}</DialogTitle>
            <DialogDescription>{t("familyRequiredDescription")}</DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsNoFamilyDialogOpen(false)}>
              {t("close")}
            </Button>
            <Button
              type="button"
              nativeButton={false}
              onClick={() => setIsNoFamilyDialogOpen(false)}
              render={<Link href="/family">{t("goToFamilyPlan")}</Link>}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
