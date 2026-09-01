/**
 * 服务账号引导(ADR 0001):为 coding agent 建账号、发/管 API Key。
 *
 * 用法:
 *   npm run make-agent -- <账号名>                    # 建服务账号(不存在时,USER 角色)+ 发无人值守 key
 *   npm run make-agent -- --attended <账号名>         # 给已有账号发「在场交互」key(硬排除动作放行)
 *   npm run make-agent -- --key <账号名> [--name X]   # 给已有账号再发一把无人值守 key
 *   npm run make-agent -- --list [账号名]             # 查看账号与凭证
 *   npm run make-agent -- --revoke <bma_前缀或keyId>  # 撤销凭证(泄露/换人时)
 *
 * key 明文仅创建时展示一次(库中只存 SHA-256)。凭据写入 ~/.budget-agent.json
 * (chmod 600)后,MCP server 与 agent skill 均自动读取。
 * 项目授权:以 ADMIN 在「项目概览 → 成员管理」把服务账号加为成员(OWNER 可编辑)。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { loadEnvConfig } from '@next/env';

const prisma = new PrismaClient();

function generateKey(): string {
  return `bma_${randomBytes(16).toString('hex')}`;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function usage(): never {
  console.error(
    [
      '用法:',
      '  npm run make-agent -- <账号名>                    # 建服务账号 + 发无人值守 key',
      '  npm run make-agent -- --attended <账号名>         # 发「在场交互」key(硬排除动作放行)',
      '  npm run make-agent -- --key <账号名> [--name X]   # 再发一把无人值守 key',
      '  npm run make-agent -- --list [账号名]             # 查看账号与凭证',
      '  npm run make-agent -- --revoke <bma_前缀或keyId>  # 撤销凭证',
    ].join('\n'),
  );
  process.exit(1);
}

async function findUserByName(name: string) {
  return prisma.user.findFirst({ where: { name } });
}

async function ensureUser(name: string) {
  const existing = await findUserByName(name);
  if (existing) return existing;
  const user = await prisma.user.create({
    data: { id: randomUUID(), name, role: 'USER', status: 'active' },
  });
  console.log(`✅ 已创建服务账号: ${user.name} (${user.id}),角色 USER`);
  return user;
}

async function issueKey(userId: string, unattended: boolean, name: string) {
  const key = generateKey();
  const rec = await prisma.apiKey.create({
    data: {
      id: randomUUID(),
      userId,
      name,
      keyHash: sha256(key),
      prefix: key.slice(0, 10),
      unattended,
    },
  });
  return { rec, key };
}

async function main() {
  loadEnvConfig(process.cwd());
  const [first, second, third] = process.argv.slice(2);
  const baseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

  if (!first) usage();

  if (!first.startsWith('--')) {
    // 默认:建账号 + 发无人值守 key
    const user = await ensureUser(first);
    const { rec, key } = await issueKey(user.id, true, 'default');
    console.log(`\n🔑 无人值守 key 已创建(${rec.prefix}…,id ${rec.id})`);
    console.log(`⚠️  明文仅此一次展示:\n\n   ${key}\n`);
    console.log('写入 ~/.budget-agent.json(chmod 600)供 MCP / skill 读取:');
    console.log(JSON.stringify({ baseUrl, token: key }, null, 2));
    console.log(
      `\n项目授权:以 ADMIN 在「项目概览 → 成员管理」把 ${user.name} 加为项目成员(OWNER 可编辑)。`,
    );
    return;
  }

  if (first === '--attended' || first === '--key') {
    if (!second) usage();
    const user = await findUserByName(second);
    if (!user) {
      console.error(`未找到用户: ${second}(先运行 npm run make-agent -- ${second})`);
      process.exit(1);
    }
    const unattended = first === '--key';
    const name = third ?? (unattended ? 'default' : 'attended');
    const { rec, key } = await issueKey(user.id, unattended, name);
    console.log(
      `\n🔑 ${unattended ? '无人值守' : '在场交互'} key 已创建(${rec.prefix}…,id ${rec.id})`,
    );
    console.log(`⚠️  明文仅此一次展示:\n\n   ${key}\n`);
    console.log('写入 ~/.budget-agent.json(chmod 600):');
    console.log(JSON.stringify({ baseUrl, token: key }, null, 2));
    return;
  }

  if (first === '--list') {
    const users = await prisma.user.findMany({
      where: second ? { name: second } : undefined,
      include: { apiKeys: { orderBy: { createdAt: 'desc' } } },
    });
    for (const u of users) {
      console.log(`\n${u.name} (${u.id}) 角色=${u.role} 状态=${u.status}`);
      if (u.apiKeys.length === 0) {
        console.log('  (无凭证)');
        continue;
      }
      for (const k of u.apiKeys) {
        console.log(
          `  ${k.revokedAt ? '🚫已撤销' : '✅有效'} ${k.prefix}… id=${k.id} 名称=${k.name} ` +
            `${k.unattended ? '无人值守' : '在场交互'} lastUsed=${k.lastUsedAt?.toISOString() ?? '从未'}`,
        );
      }
    }
    if (users.length === 0) console.log('(无匹配用户)');
    return;
  }

  if (first === '--revoke') {
    if (!second) usage();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(second);
    const rec = await prisma.apiKey.findFirst({
      where: isUuid ? { id: second } : { prefix: { startsWith: second } },
    });
    if (!rec) {
      console.error(`未找到凭证: ${second}(用 --list 查看前缀)`);
      process.exit(1);
    }
    if (rec.revokedAt) {
      console.log(`该凭证已撤销: ${rec.prefix}… (${rec.id})`);
      return;
    }
    await prisma.apiKey.update({ where: { id: rec.id }, data: { revokedAt: new Date() } });
    console.log(`🚫 已撤销凭证: ${rec.prefix}… (${rec.id})`);
    return;
  }

  usage();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
