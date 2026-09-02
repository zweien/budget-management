-- 重复数据防护(ADR 0002):单据编号在项目内、未作废记录上的唯一性
-- = 应用层查重的最终兜底(并发确认/旁路入口都逃不过 DB 约束)。
-- 部分唯一索引:作废记录不占编号——撤销后同一单据可重新导入。
-- Prisma schema 无法表达 partial index,故以裸 SQL 维护。
-- (duplicate_level 列由迁移 20260902024332 添加。)
CREATE UNIQUE INDEX "business_records_project_docno_active_unique"
  ON "business_records"("project_id", "docNo")
  WHERE "docNo" IS NOT NULL AND "is_void" = false;
