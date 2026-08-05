-- v0.3.0 用户系统:UserRole 收敛为 ADMIN/USER + users.auth_subject(SSO JIT 匹配键)
-- + 按 projects.owner_id 回填 project_members OWNER 行(编辑权改由成员表驱动)

-- 1. users 增加 auth_subject(SSO 用户的 Authentik sub;mock/种子用户为 NULL)
ALTER TABLE "users" ADD COLUMN "auth_subject" TEXT;
CREATE UNIQUE INDEX "users_auth_subject_key" ON "users"("auth_subject");

-- 2. UserRole 枚举收敛:BUDGET_ADMIN→ADMIN,PROJECT_OWNER/AUTHORIZED_HANDLER→USER
--    (PG 枚举不能改值,走 rename + 重建 + USING 映射)
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole" USING (
  CASE "role"::text WHEN 'BUDGET_ADMIN' THEN 'ADMIN' ELSE 'USER' END::"UserRole"
);
DROP TYPE "UserRole_old";

-- 3. 回填:项目名义负责人自动成为 OWNER 成员(获得该项目编辑权)
--    已有成员行(如 HANDLER)则升级为 OWNER
INSERT INTO "project_members" ("id", "project_id", "user_id", "member_role", "authorized_at")
SELECT gen_random_uuid(), p."id", p."owner_id", 'OWNER', now()
FROM "projects" p
ON CONFLICT ("project_id", "user_id") DO UPDATE SET "member_role" = 'OWNER';
