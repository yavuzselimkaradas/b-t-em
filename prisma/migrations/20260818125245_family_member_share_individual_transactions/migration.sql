-- Her üyenin kendi kontrolündeki tercihi: açıksa, bireysel (familyId: null)
-- işlemleri ailenin ortak görünümünde de (salt-okunur) görünür.
ALTER TABLE "FamilyMember" ADD COLUMN "shareIndividualTransactions" BOOLEAN NOT NULL DEFAULT false;
