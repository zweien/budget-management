-- 成员顺序(第一负责人口径):project_members 增加展示排序列。
-- 成员管理支持调整顺序;调整表「项目负责人」与概览/列表负责人显示按「顺序最前的 OWNER」取值。
-- 旧数据默认 0,排序时 sortOrder 相同则按 authorizedAt 兜底,保证稳定(同 BudgetSubject.sortOrder 惯例)。

-- AlterTable
ALTER TABLE "project_members" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- 回填:按既有展示口径给存量成员一个稳定顺序——OWNER 在前(按授权时间倒序,
-- 最新授权者即原「项目负责人」口径,回填后仍排第一),HANDLER 在后(按授权时间正序)。
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY project_id
      ORDER BY
        CASE WHEN member_role = 'OWNER' THEN 0 ELSE 1 END,
        CASE WHEN member_role = 'OWNER' THEN authorized_at END DESC,
        authorized_at ASC
    ) AS rn
  FROM "project_members"
)
UPDATE "project_members" pm SET "sort_order" = ranked.rn FROM ranked WHERE pm.id = ranked.id;
