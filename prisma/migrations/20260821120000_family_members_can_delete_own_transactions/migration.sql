-- Owner-only toggle: açıkken bir MEMBER, KENDİ oluşturduğu GERÇEK aile
-- işlemini (Transaction.familyId set) silebilir — başka üyenin ya da
-- owner'ın işlemine dokunamaz. Owner'ın silme yetkisi her zaman tam kalır.
-- Bkz. Family modelindeki yorum.
ALTER TABLE "Family" ADD COLUMN     "membersCanDeleteOwnTransactions" BOOLEAN NOT NULL DEFAULT false;
