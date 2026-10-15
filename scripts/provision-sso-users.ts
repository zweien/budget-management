/**
 * 预先为 Authentik 用户在预算系统建档(等价于 SSO 首次登录的 JIT 建档,role=USER)。
 *
 * 输入 JSON 清单:[{ "username": "全拼", "name": "中文姓名", "sub": "<Authentik sub>" }]
 * sub 获取(本机 Authentik,sub_mode=hashed_user_id):
 *   sub = sha256("<authentik_core_user.id 整型>-<authentik_install_id 的 id>")
 * 已按 auth_subject 绑定过的用户跳过(不动角色/名称/状态)。
 *
 * 用法: tsx scripts/provision-sso-users.ts <users.json>
 */
import { readFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';
import { v7 as uuidv7 } from 'uuid';

interface Entry {
  username: string;
  name: string;
  sub: string;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: tsx scripts/provision-sso-users.ts <users.json>');
    process.exit(1);
  }
  const entries: Entry[] = JSON.parse(readFileSync(file, 'utf-8'));
  const prisma = new PrismaClient();
  try {
    let created = 0;
    let skipped = 0;
    for (const { username, name, sub } of entries) {
      if (!username || !name || !sub) {
        throw new Error(
          `清单条目缺字段,需要 username/name/sub:${JSON.stringify({ username, name, sub })}`,
        );
      }
      const existing = await prisma.user.findUnique({ where: { authSubject: sub } });
      if (existing) {
        skipped += 1;
        console.log(`SKIP    ${username.padEnd(15)} 已绑定(用户:${existing.name})`);
        continue;
      }
      const user = await prisma.user.create({
        data: { id: uuidv7(), authSubject: sub, name, role: 'USER' },
      });
      created += 1;
      console.log(`CREATED ${username.padEnd(15)} ${name} (userId=${user.id})`);
    }
    console.log(`完成:新建 ${created},跳过 ${skipped},共 ${entries.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
