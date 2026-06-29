-- AlterTable
ALTER TABLE "User" ADD COLUMN "mediawikiId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_mediawikiId_key" ON "User"("mediawikiId");
