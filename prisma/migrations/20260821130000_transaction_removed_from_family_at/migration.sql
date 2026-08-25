-- Bilerek removeTransactionFromFamily ile aile görünümünden kaldırılmış bir
-- işlemi, geri paylaşılmaya kadar KALICI olarak işaretler — force-share'in bu
-- satırı bir daha asla göstermemesi için. Bkz. Transaction modelindeki yorum.
ALTER TABLE "Transaction" ADD COLUMN "removedFromFamilyAt" TIMESTAMP(3);
