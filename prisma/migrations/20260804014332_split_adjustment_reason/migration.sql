/*
  Warnings:

  - You are about to drop the column `reason` on the `budget_adjustments` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "budget_adjustments" DROP COLUMN "reason",
ADD COLUMN     "annual_reason" TEXT,
ADD COLUMN     "total_reason" TEXT;
