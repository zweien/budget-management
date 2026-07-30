/**
 * 开发种子数据:3 个角色用户。
 * 运行:`npm run db:seed` 或 `npx tsx prisma/seed.ts`
 *
 * 用户 id 用 uuidv7(应用层约定)。User.id 在 schema 中无 @default,必须显式提供。
 */
import { PrismaClient, UserRole } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

const prisma = new PrismaClient();

async function main() {
  const users = [
    { id: uuidv7(), name: '张管理', role: UserRole.BUDGET_ADMIN, status: 'active' },
    { id: uuidv7(), name: '李负责人', role: UserRole.PROJECT_OWNER, status: 'active' },
    { id: uuidv7(), name: '王经办人', role: UserRole.AUTHORIZED_HANDLER, status: 'active' },
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
