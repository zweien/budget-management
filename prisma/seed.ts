/**
 * 开发种子数据:管理员 + 2 个普通用户。
 * 运行:`npm run db:seed` 或 `npx tsx prisma/seed.ts`
 *
 * 用户 id 用 uuidv7(应用层约定)。User.id 在 schema 中无 @default,必须显式提供。
 * v0.3.0 起角色收敛为 ADMIN/USER;项目编辑权由 ProjectMember(OWNER) 驱动
 * (种子不含项目,成员关系由管理员在项目概览页设定)。
 */
import { PrismaClient, UserRole } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  const users = [
    { id: uuidv7(), name: '张管理', role: UserRole.ADMIN, status: 'active' },
    { id: uuidv7(), name: '李负责人', role: UserRole.USER, status: 'active' },
    { id: uuidv7(), name: '王经办人', role: UserRole.USER, status: 'active' },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: {},
      create: u,
    });
  }

  console.log('✅ 已种子 %d 个用户:', users.length);
  for (const u of users) {
    console.log('   - %s (%s) id=%s', u.name, u.role, u.id);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
