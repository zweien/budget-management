-- CreateIndex
CREATE INDEX "audit_logs_operated_at_idx" ON "audit_logs"("operated_at");

-- CreateIndex
CREATE INDEX "audit_logs_operator_id_idx" ON "audit_logs"("operator_id");

-- CreateIndex
CREATE INDEX "business_record_history_business_record_id_operated_at_idx" ON "business_record_history"("business_record_id", "operated_at");

-- CreateIndex
CREATE INDEX "business_records_project_id_business_date_idx" ON "business_records"("project_id", "business_date");

-- CreateIndex
CREATE INDEX "import_rows_batch_id_idx" ON "import_rows"("batch_id");

-- CreateIndex
CREATE INDEX "receipt_records_project_id_receipt_date_idx" ON "receipt_records"("project_id", "receipt_date");
