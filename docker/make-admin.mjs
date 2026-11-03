/**
 * 将本地用户提升为 ADMIN(SSO 首个管理员引导用)——镜像内置版。
 *
 * 用法: docker exec -it budget-app node docker/make-admin.mjs <姓名/显示名 或 用户ID 或 SSO sub(UUID)>
 *
 * 与 scripts/make-admin.ts 语义一致(该脚本需仓库代码 + Node 环境,离线内网部署机没有,
 * 故随镜像分发本等价工具):UUID 输入按 本地id / authSubject(SSO sub) / name 匹配,
 * 非 UUID 按 name;同名多行拒绝并要求改用 id / sub 精确指定(防绑错账号)。
 * 数据库连接取容器 env 的 DATABASE_URL(standalone node_modules 已含 @prisma/client)。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// id 是 UUID 列:非 UUID 输入不能只靠 OR 兜底(Prisma 会先在校验阶段报错)。
const isUuid = (key) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);

async function main() {
  const key = process.argv[2]?.trim();
  if (!key) {
    console.error('用法: node docker/make-admin.mjs <用户名或用户ID>');
    process.exit(1);
  }

  // 查找与歧义拒绝逻辑须与 scripts/make-admin.ts 完全一致(安全审计 bm1-adm-cli 修复:
  // User.name 无唯一约束,findFirst 同名多行时选中行不确定,可能把 ADMIN 提到错误账号上)。
  const users = await prisma.user.findMany({
    where: isUuid(key) ? { OR: [{ id: key }, { authSubject: key }, { name: key }] } : { name: key },
    orderBy: { createdAt: 'asc' },
  });
  if (users.length === 0) {
    console.error(
      `未找到用户: ${key}(请先通过 SSO 登录一次完成自动建档;` +
        '显示名优先建档时 Authentik 登录名不入库,可改传显示名或 SSO sub UUID)',
    );
    process.exit(1);
  }
  if (users.length > 1) {
    console.error(
      `匹配到 ${users.length} 个用户,拒绝歧义提升(防绑错账号)。请改用用户 id 或 SSO sub UUID 精确指定:`,
    );
    for (const u of users) {
      console.error(`  - ${u.name} (${u.id}) 角色=${u.role} 状态=${u.status}`);
    }
    process.exit(1);
  }
  const user = users[0];
  if (user.role === 'ADMIN') {
    console.log(`已是管理员,无需变更: ${user.name} (${user.id})`);
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
  console.log(`✅ 已提升为管理员: ${user.name} (${user.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
