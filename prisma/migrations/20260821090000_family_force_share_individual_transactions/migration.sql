-- Owner-only kilit: açıkken tüm MEMBER'ların bireysel işlemleri aile
-- görünümünde otomatik paylaşılmış sayılır, üyeler kendi paylaşma
-- tercihlerini değiştiremez. Bkz. Family modelindeki yorum.
ALTER TABLE "Family" ADD COLUMN     "forceShareIndividualTransactions" BOOLEAN NOT NULL DEFAULT false;
