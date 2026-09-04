-- 导入批次记录确认结果计数:文件行数之外的「实际导入行数」(+ 补全更新行数)。
ALTER TABLE "import_batches" ADD COLUMN IF NOT EXISTS "created_count" INTEGER;
ALTER TABLE "import_batches" ADD COLUMN IF NOT EXISTS "updated_count" INTEGER;
