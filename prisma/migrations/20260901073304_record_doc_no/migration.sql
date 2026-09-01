-- AlterTable
ALTER TABLE "business_records" ADD COLUMN     "docNo" TEXT;

-- CreateIndex
CREATE INDEX "business_records_project_id_docNo_idx" ON "business_records"("project_id", "docNo");
