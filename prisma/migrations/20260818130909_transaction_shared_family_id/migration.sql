-- Kişisel bir işlemin, oluşturulduğu ANDAKİ paylaşım tercihine göre kalıcı
-- olarak "damgalandığı" aile — bkz. Transaction modelindeki yorum.
ALTER TABLE "Transaction" ADD COLUMN "sharedFamilyId" TEXT;
CREATE INDEX "Transaction_sharedFamilyId_idx" ON "Transaction"("sharedFamilyId");
