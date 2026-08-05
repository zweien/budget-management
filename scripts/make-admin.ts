/**
 * 将本地用户提升为 ADMIN(SSO 首个管理员引导用)。
 *
 * 用法: npx tsx scripts/make-admin.ts <用户名或用户ID>
 *
 * 场景:SSO 首次登录走 JIT 自动建档(默认 USER)。第一个需要管理员权限的人,
 * 先用 Authentik 账号登录一次系统(完成建档),再运行本脚本提升。
 * 之后即可在「项目详情 → 成员管理」界面内维护各项目负责人。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const key = process.argv[2]?.trim();
  if (!key) {
    console.error('用法: npx tsx scripts/make-admin.ts <用户名或用户ID>');
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { OR: [{ id: key }, { name: key }] } });
  if (!user) {
    console.error(`未找到用户: ${key}(请先通过 SSO 登录一次完成自动建档)`);
    process.exit(1);
  }
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
