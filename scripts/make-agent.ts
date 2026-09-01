/**
 * 凭证引导(ADR 0001):为 coding agent 建服务账号、发/管 API Key(管理 UI 的脚本形态)。
 * 个人自助签发请用系统内「API 凭证」页;本脚本面向长期无人值守的服务账号场景。
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
 * 脚本签发的凭证档位为「完整」、项目范围为「全部」——收权靠移除账号的项目成员关系。
 */
import { loadEnvConfig } from '@next/env';

import { PrismaClient } from '@prisma/client';
import { HTTPError } from '@/lib/auth/session';
import { issueApiKey, revokeApiKey } from '@/server/services/apiKey.service';

const prisma = new PrismaClient();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const { randomUUID } = await import('node:crypto');
  const user = await prisma.user.create({
    data: { id: randomUUID(), name, role: 'USER', status: 'active' },
  });
  console.log(`✅ 已创建服务账号: ${user.name} (${user.id}),角色 USER`);
  return user;
}

async function issue(userId: string, unattended: boolean, name: string) {
  try {
    return await issueApiKey({
      userId,
      name,
      unattended,
      tier: 'full',
      projectScope: 'all',
    });
  } catch (e) {
    if (e instanceof HTTPError) {
      console.error(`签发失败: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

function printIssued(
  rec: { id: string; prefix: string; unattended: boolean },
  plaintext: string,
  baseUrl: string,
) {
  console.log(
    `\n🔑 ${rec.unattended ? '无人值守' : '在场交互'} key 已创建(${rec.prefix}…,id ${rec.id})`,
  );
  console.log(`⚠️  明文仅此一次展示:\n\n   ${plaintext}\n`);
  console.log('写入 ~/.budget-agent.json(chmod 600)供 MCP / skill 读取:');
  console.log(JSON.stringify({ baseUrl, token: plaintext }, null, 2));
}

async function main() {
  loadEnvConfig(process.cwd());
  const [first, second, third] = process.argv.slice(2);
  const baseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

  if (!first) usage();

  if (!first.startsWith('--')) {
    // 默认:建账号 + 发无人值守 key
    const user = await ensureUser(first);
    const { record, plaintext } = await issue(user.id, true, 'default');
    printIssued(record, plaintext, baseUrl);
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
    const { record, plaintext } = await issue(user.id, unattended, name);
    printIssued(record, plaintext, baseUrl);
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
        const scope =
          k.projectScope === 'selected'
            ? ` 项目×${Array.isArray(k.projectIds) ? k.projectIds.length : 0}`
            : '';
        console.log(
          `  ${k.revokedAt ? '🚫已撤销' : '✅有效'} ${k.prefix}… id=${k.id} 名称=${k.name} ` +
            `${k.unattended ? '无人值守' : '在场交互'} 档位=${k.tier}${scope}` +
            `${k.expiresAt ? ` 过期=${k.expiresAt.toISOString()}` : ''} lastUsed=${k.lastUsedAt?.toISOString() ?? '从未'}`,
        );
      }
    }
    if (users.length === 0) console.log('(无匹配用户)');
    return;
  }

  if (first === '--revoke') {
    if (!second) usage();
    const rec = await prisma.apiKey.findFirst({
      where: UUID_RE.test(second) ? { id: second } : { prefix: { startsWith: second } },
    });
    if (!rec) {
      console.error(`未找到凭证: ${second}(用 --list 查看前缀)`);
      process.exit(1);
    }
    await revokeApiKey(rec.userId, rec.id);
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
