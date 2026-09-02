-- 重复数据防护(ADR 0002)。
-- 注:本迁移自洽(IF NOT EXISTS / 预检),可重复应用;早期的 20260902024332/24338
-- 两个一次性迁移已合并至此。

-- 1) 导入行重复档位:none / hard(单据编号硬重复,禁止确认)/ suspected(指纹疑似,可强制)。
ALTER TABLE "import_rows"
  ADD COLUMN IF NOT EXISTS "duplicate_level" TEXT NOT NULL DEFAULT 'none';

-- 2) 唯一索引冲突预检:老版结算单「强制导入」可能留下未作废同号记录,
--    直接建唯一索引会阻断部署。此处显式失败并给出定位与处置 SQL。
DO $$
DECLARE conflict_groups int;
BEGIN
  SELECT count(*) INTO conflict_groups FROM (
    SELECT 1 FROM "business_records"
    WHERE "docNo" IS NOT NULL AND "is_void" = false
    GROUP BY "project_id", "docNo"
    HAVING count(*) > 1
  ) t;
  IF conflict_groups > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('存在 %s 组未作废的重复单据编号,无法创建唯一索引', conflict_groups),
      DETAIL = '定位:SELECT p.code, r."docNo", count(*) FROM business_records r JOIN projects p ON p.id = r.project_id WHERE r."docNo" IS NOT NULL AND r.is_void = false GROUP BY 1, 2 HAVING count(*) > 1',
      HINT = '处理原则:保留每组最新一条,其余人工作废(保留 is_void 痕迹)或修改编号,然后重新运行迁移。';
  END IF;
END $$;

-- 3) 部分唯一索引:未作废记录的项目内单据编号唯一(应用层查重的最终兜底;
--    作废记录不占编号,撤销后可重导)。Prisma schema 无法表达 partial index,以裸 SQL 维护。
CREATE UNIQUE INDEX IF NOT EXISTS "business_records_project_docno_active_unique"
  ON "business_records"("project_id", "docNo")
  WHERE "docNo" IS NOT NULL AND "is_void" = false;
