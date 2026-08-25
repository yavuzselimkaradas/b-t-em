"use client";

import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Pencil,
  RefreshCw,
  Trash2,
  UserMinus,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatAmount } from "@/lib/domain/currency";
import type { FamilyTransactionRow } from "@/lib/server/actions/family-transactions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getCategoryVisual } from "@/components/transactions/category-visual";

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC", // dates are stored as UTC midnight — see transaction-form.tsx
});

export type FamilyListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "success";
      items: FamilyTransactionRow[];
      page: number;
      totalPages: number;
      total: number;
    };

interface FamilyTransactionListProps {
  listState: FamilyListState;
  isRefetching: boolean;
  /** Every member (owner or not) may EDIT their OWN entries — real family
   * transactions AND ones merely shared into this family's view alike —
   * never another member's (see `canEditTransaction`'s doc comment in
   * lib/domain/transactions/authorization.ts: ownership-only, role is
   * irrelevant for editing). DELETING is stricter and depends on the row
   * type too — see `isOwner` below. The actions column is ALWAYS shown
   * (every viewer owns at least the rows they themselves created), but
   * each row's menu only offers what the viewer is actually allowed to do —
   * offering a control that would only ever get rejected server-side is
   * just a confusing extra step, not a real permission boundary (that's
   * still enforced server-side regardless). */
  currentUserId: string | undefined;
  /** Gates "Aile hesabından kaldır" (`removeTransactionFromFamily` /
   * `assertCanRemoveFromFamily`, same predicate as the old single-action
   * `canDeleteTransaction`, lib/domain/transactions/authorization.ts): a
   * REAL family transaction can always be removed by that family's OWNER —
   * of ANY row, not just ones they created. A MEMBER can only remove one of
   * their OWN REAL family transactions, and only when
   * `membersCanDeleteOwnTransactions` is on (see that prop) — otherwise
   * never, not even their own. A row merely SHARED into this family's view
   * (not itself family-owned) can be removed by the OWNER too, OR by its
   * own creator regardless of this flag (sharing never removes control over
   * your own data). ON TOP of all that, `forceShareIndividualTransactions`
   * (see that prop below) unconditionally blocks a MEMBER from removing
   * their OWN row while it's on — the OWNER is never affected. This does NOT
   * gate "Her ikisinden sil" — see `canDeleteEverywhereThisRow` below,
   * that's ownership-only on top of this. */
  isOwner: boolean;
  /** `FamilyData.membersCanDeleteOwnTransactions` — the owner-controlled
   * "Aile Planı Ayarları" switch (see `MembersCanDeleteOwnTransactionsToggle`).
   * Only relevant to REAL family transactions (`familyId` set): when on, a
   * MEMBER may act on one of THEIR OWN such rows, never another member's or
   * the owner's. Purely cosmetic here — the actual boundary is enforced by
   * `assertCanRemoveFromFamily`/`assertCanDeleteEverywhere` server-side
   * regardless of this prop. */
  membersCanDeleteOwnTransactions: boolean;
  /** `FamilyData.forceShareIndividualTransactions` — the owner-controlled
   * "zorla paylaş" kill switch (see `ForceShareToggle`, "Aile Planı
   * Ayarları"). When on, a MEMBER (never the OWNER) can no longer remove
   * THEIR OWN row from the family view — real family transaction or merely
   * shared-in individual one alike — even where `isOwnRow`/
   * `membersCanDeleteOwnTransactions` above would otherwise allow it; the
   * server (`assertCanRemoveFromFamily`, lib/server/actions/transactions.ts)
   * rejects that request unconditionally while this switch is on, so hiding
   * the control here just avoids offering one that would only ever get
   * rejected — same reasoning as the rest of this file's gating. Never
   * affects the OWNER acting on another member's row. */
  forceShareIndividualTransactions: boolean;
  onRetry: () => void;
  onEdit: (transaction: FamilyTransactionRow) => void;
  /** "Aile hesabından kaldır" — clears the row's family attribution only
   * (`removeTransactionFromFamily`). Never touches the row's own creator's
   * individual `/transactions` view. Offered whenever
   * `canRemoveFromFamilyThisRow` is true (see below) — the OWNER on any
   * row, or the row's own creator. */
  onRemoveFromFamily: (transaction: FamilyTransactionRow) => void;
  /** "Her ikisinden sil" — fully soft-deletes the row everywhere
   * (`softDeleteTransaction`). SADECE offered for the viewer's OWN row (see
   * `canDeleteEverywhereThisRow`), owner dahil: an owner can never fully
   * delete another member's data this way, only remove it from the family
   * view. */
  onDeleteEverywhere: (transaction: FamilyTransactionRow) => void;
  onPageChange: (page: number) => void;
  onCreate: () => void;
}

export function FamilyTransactionList({
  listState,
  isRefetching,
  currentUserId,
  isOwner,
  membersCanDeleteOwnTransactions,
  forceShareIndividualTransactions,
  onRetry,
  onEdit,
  onRemoveFromFamily,
  onDeleteEverywhere,
  onPageChange,
  onCreate,
}: FamilyTransactionListProps) {
  if (listState.status === "loading") {
    return <FamilyTransactionsSkeleton />;
  }

  if (listState.status === "error") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl bg-card py-14 text-center ring-1 ring-foreground/10">
        <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" strokeWidth={2} />
        </span>
        <div>
          <p className="font-medium text-foreground">İşlemler yüklenemedi</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{listState.message}</p>
        </div>
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Tekrar dene
        </Button>
      </div>
    );
  }

  if (listState.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border bg-transparent py-14 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
          <Users className="size-6" strokeWidth={2} />
        </span>
        <div>
          <p className="font-medium text-foreground">Bu aralıkta işlem yok</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            İlk gelir veya gider kaydını ekleyerek ailenle paylaşmaya başla.
          </p>
          <Button className="mt-4" onClick={onCreate}>
            İlk işlemi ekle
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 transition-opacity",
          isRefetching && "pointer-events-none opacity-60"
        )}
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Tarih</TableHead>
              <TableHead>Kategori</TableHead>
              <TableHead className="hidden sm:table-cell">Ekleyen</TableHead>
              <TableHead className="hidden sm:table-cell">Tür</TableHead>
              <TableHead className="text-right">Tutar</TableHead>
              <TableHead className="w-9" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {listState.items.map((transaction) => (
              <FamilyTransactionRowItem
                key={transaction.id}
                transaction={transaction}
                currentUserId={currentUserId}
                isOwner={isOwner}
                membersCanDeleteOwnTransactions={membersCanDeleteOwnTransactions}
                forceShareIndividualTransactions={forceShareIndividualTransactions}
                onEdit={() => onEdit(transaction)}
                onRemoveFromFamily={() => onRemoveFromFamily(transaction)}
                onDeleteEverywhere={() => onDeleteEverywhere(transaction)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
        <span>{listState.total} işlem</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={listState.page <= 1}
            onClick={() => onPageChange(listState.page - 1)}
          >
            <ChevronLeft className="size-3.5" />
            Önceki
          </Button>
          <span className="tabular-nums">
            Sayfa {listState.page} / {listState.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={listState.page >= listState.totalPages}
            onClick={() => onPageChange(listState.page + 1)}
          >
            Sonraki
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function FamilyTransactionRowItem({
  transaction,
  currentUserId,
  isOwner,
  membersCanDeleteOwnTransactions,
  forceShareIndividualTransactions,
  onEdit,
  onRemoveFromFamily,
  onDeleteEverywhere,
}: {
  transaction: FamilyTransactionRow;
  currentUserId: string | undefined;
  isOwner: boolean;
  membersCanDeleteOwnTransactions: boolean;
  forceShareIndividualTransactions: boolean;
  onEdit: () => void;
  onRemoveFromFamily: () => void;
  onDeleteEverywhere: () => void;
}) {
  const isIncome = transaction.type === "INCOME";
  const visual = getCategoryVisual(transaction.category);
  const Icon = visual.icon;
  // A row can be a genuine family transaction OR another member's shared
  // individual one (see share-transactions-toggle.tsx) — BOTH are
  // actionable from this view now, mirroring
  // canEditTransaction/canDeleteTransaction (lib/domain/transactions/
  // authorization.ts) exactly:
  //  - Edit: ownership-only, regardless of row type — only whoever created
  //    the entry may edit it, owner or member alike.
  //  - "Aile hesabından kaldır" (`removeTransactionFromFamily`): for a REAL
  //    family transaction (`familyId` set), the OWNER may always remove ANY
  //    of them from the family view. A MEMBER may remove one only when it's
  //    their OWN row AND the owner has turned on
  //    `membersCanDeleteOwnTransactions` (see
  //    `MembersCanDeleteOwnTransactionsToggle`, "Aile Planı Ayarları") —
  //    otherwise never, not even their own. For a row that's merely SHARED
  //    into this family's view (`familyId` null — every such row here was
  //    matched via `sharedFamilyId`, see family-transactions.ts's
  //    `buildFamilyTransactionWhere`), its own creator may always remove it
  //    too regardless of that toggle (sharing never removes control over
  //    your own data) — so this is "owner OR creator", unaffected.
  //  - "Her ikisinden sil" (`softDeleteTransaction`): ALWAYS ownership-only
  //    on top of the above, owner included — nobody, not even the family's
  //    owner, can fully delete another member's individual data. Only
  //    offered for the viewer's OWN row, and only when they could also
  //    remove it from the family (same underlying permission, just also
  //    requiring ownership).
  //  - Force-share lock: while `forceShareIndividualTransactions` is on, a
  //    MEMBER (never the OWNER) can't remove THEIR OWN row from the family
  //    view at all — regardless of row type or `membersCanDeleteOwnTransactions`
  //    above — same rule `assertCanRemoveFromFamily` enforces server-side.
  //    Doesn't touch the OWNER acting on someone else's row.
  // `assertCanEditTransaction`/`assertCanRemoveFromFamily`/
  // `assertCanDeleteEverywhere` (transactions.ts) enforce all of this
  // server-side regardless — hiding a control the viewer can't use here
  // just avoids offering one that would only ever get rejected.
  const isOwnRow = transaction.userId === currentUserId;
  const canEditThisRow = isOwnRow;
  // Unlocked baseline — mirrors `canDeleteTransaction` server-side exactly
  // (lib/domain/transactions/authorization.ts). The force-share lock below
  // is layered ONLY on top of the "remove from family" action, never on
  // "delete everywhere": `assertCanDeleteEverywhere`/
  // `canDeleteTransactionEverywhere` are untouched by
  // `forceShareIndividualTransactions` — a member can always fully delete
  // their OWN data outright, force-share only blocks the "hide without
  // deleting" move. Computing `canDeleteEverywhereThisRow` from this
  // unlocked baseline (not from the locked `canRemoveFromFamilyThisRow`)
  // keeps that distinction intact in the UI too.
  const canRemoveFromFamilyBase =
    transaction.familyId !== null
      ? isOwner || (isOwnRow && membersCanDeleteOwnTransactions)
      : isOwnRow || isOwner;
  const forceShareLocksOwnRemoval = !isOwner && isOwnRow && forceShareIndividualTransactions;
  const canRemoveFromFamilyThisRow = canRemoveFromFamilyBase && !forceShareLocksOwnRemoval;
  const canDeleteEverywhereThisRow = isOwnRow && canRemoveFromFamilyBase;

  return (
    <TableRow>
      <TableCell className="text-muted-foreground">{dateFormatter.format(transaction.date)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full",
              visual.bg,
              visual.fg
            )}
          >
            <Icon className="size-3.5" strokeWidth={2.25} />
          </span>
          <div className="min-w-0">
            <span className="block font-medium text-foreground">{transaction.category.name}</span>
            {transaction.description ? (
              <span className="block truncate text-xs text-muted-foreground">
                {transaction.description}
              </span>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden text-muted-foreground sm:table-cell">{transaction.ownerName}</TableCell>
      <TableCell className="hidden sm:table-cell">
        {isIncome ? (
          <Badge className="gap-1 border-transparent bg-income-soft text-income">
            <ArrowUpRight className="size-3" strokeWidth={2.5} />
            Gelir
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1">
            <ArrowDownRight className="size-3" strokeWidth={2.5} />
            Gider
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <span
          className={cn(
            "num-tabular inline-flex items-center gap-1 font-medium",
            isIncome ? "text-income" : "text-destructive"
          )}
        >
          {isIncome ? (
            <ArrowUpRight className="size-3.5" strokeWidth={2.5} />
          ) : (
            <ArrowDownRight className="size-3.5" strokeWidth={2.5} />
          )}
          {isIncome ? "+" : "−"}
          {formatAmount(transaction.amount, transaction.currency)}
        </span>
      </TableCell>
      <TableCell>
        {canEditThisRow || canRemoveFromFamilyThisRow ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label="İşlem seçenekleri">
                  <MoreVertical />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {canEditThisRow ? (
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="size-4" />
                  Düzenle
                </DropdownMenuItem>
              ) : null}
              {canRemoveFromFamilyThisRow ? (
                <DropdownMenuItem onClick={onRemoveFromFamily}>
                  <UserMinus className="size-4" />
                  Aile hesabından kaldır
                </DropdownMenuItem>
              ) : null}
              {canDeleteEverywhereThisRow ? (
                <DropdownMenuItem variant="destructive" onClick={onDeleteEverywhere}>
                  <Trash2 className="size-4" />
                  Her ikisinden sil
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function FamilyTransactionsSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Tarih</TableHead>
            <TableHead>Kategori</TableHead>
            <TableHead className="hidden sm:table-cell">Ekleyen</TableHead>
            <TableHead className="hidden sm:table-cell">Tür</TableHead>
            <TableHead className="text-right">Tutar</TableHead>
            <TableHead className="w-9" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 6 }).map((_, index) => (
            <TableRow key={index} className="hover:bg-transparent">
              <TableCell>
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <div className="size-7 animate-pulse rounded-full bg-muted" />
                  <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                </div>
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <div className="h-5 w-14 animate-pulse rounded-full bg-muted" />
              </TableCell>
              <TableCell className="text-right">
                <div className="ml-auto h-4 w-20 animate-pulse rounded bg-muted" />
              </TableCell>
              <TableCell>
                <div className="size-6 animate-pulse rounded bg-muted" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
