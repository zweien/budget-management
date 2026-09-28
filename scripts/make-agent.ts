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
 *   [--actor <用户名|id>]                             # 审计操作者(谁在执行脚本;缺省记为账号自身)
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
      '  [--actor <用户名|id>]                             # 审计操作者(谁在执行脚本)',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * 按 name 精确查找用户;同名多行时列出并拒绝。
 * (安全审计修复 bm1-adm-cli-name-keyed-resolution:User.name 无唯一约束,
 *  findFirst 在同名多行时选中行不确定,可能把全量无人值守 key 发到错误账号。)
 */
async function findUserByNameStrict(name: string) {
  const users = await prisma.user.findMany({ where: { name }, orderBy: { createdAt: 'asc' } });
  if (users.length > 1) {
    console.error(
      `匹配到 ${users.length} 个同名用户「${name}」,拒绝歧义操作(防绑错账号)。请改传用户 id,或先重命名去重:`,
    );
    for (const u of users) {
      console.error(`  - ${u.name} (${u.id}) 角色=${u.role} 状态=${u.status}`);
    }
    process.exit(1);
  }
  return users[0] ?? null;
}

async function ensureUser(name: string) {
  const existing = await findUserByNameStrict(name);
  if (existing) {
    console.log(
      `⚠️ 复用既有账号: ${existing.name} (${existing.id}),角色=${existing.role} 状态=${existing.status}`,
    );
    return existing;
  }
  const { randomUUID } = await import('node:crypto');
  const user = await prisma.user.create({
    data: { id: randomUUID(), name, role: 'USER', status: 'active' },
  });
  console.log(`✅ 已创建服务账号: ${user.name} (${user.id}),角色 USER`);
  return user;
}

async function issue(userId: string, unattended: boolean, name: string, actorId?: string) {
  try {
    return await issueApiKey({
      userId,
      name,
      unattended,
      tier: 'full',
      projectScope: 'all',
      actorId,
      via: 'make-agent',
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

/** 解析参数:位置参数 + --name <名称>(codex P2:`--key alice --name nightly` 生效)+ --actor。 */
function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let nameOption: string | undefined;
  let actorOption: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name') {
      nameOption = argv[++i];
      if (!nameOption) usage();
    } else if (argv[i] === '--actor') {
      actorOption = argv[++i];
      if (!actorOption) usage();
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, nameOption, actorOption };
}

/** 解析 --actor:审计操作者(脚本代管时归因到实际管理者,而非目标账号自身)。 */
async function resolveActor(nameOrId: string | undefined) {
  if (!nameOrId) return undefined;
  const user = UUID_RE.test(nameOrId)
    ? await prisma.user.findUnique({ where: { id: nameOrId } })
    : await findUserByNameStrict(nameOrId);
  if (!user) {
    console.error(`未找到操作者用户: ${nameOrId}`);
    process.exit(1);
  }
  return user;
}

async function main() {
  loadEnvConfig(process.cwd());
  const { positional, nameOption, actorOption } = parseArgs(process.argv.slice(2));
  const actor = await resolveActor(actorOption);
  const [first, second] = positional;
  const baseUrl = (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

  if (!first) usage();

  if (!first.startsWith('--')) {
    // 默认:建账号 + 发无人值守 key
    const user = await ensureUser(first);
    const { record, plaintext } = await issue(user.id, true, 'default', actor?.id);
    printIssued(record, plaintext, baseUrl);
    console.log(
      `\n项目授权:以 ADMIN 在「项目概览 → 成员管理」把 ${user.name} 加为项目成员(OWNER 可编辑)。`,
    );
    return;
  }

  if (first === '--attended' || first === '--key') {
    if (!second) usage();
    const user = await findUserByNameStrict(second);
    if (!user) {
      console.error(`未找到用户: ${second}(先运行 npm run make-agent -- ${second})`);
      process.exit(1);
    }
    const unattended = first === '--key';
    const name = nameOption ?? (unattended ? 'default' : 'attended');
    const { record, plaintext } = await issue(user.id, unattended, name, actor?.id);
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
    // 安全审计修复(bm1 审计 make-agent --revoke 弱选择器):撤销按 UUID 或「完整前缀」
    // 精确解析;前缀短于完整形态(bma_+6 hex=10 字符)或命中多把凭证时列出并拒绝,
    // 防止截断输入匹配到任意凭证、撤错对象而泄露的 key 继续有效。
    if (UUID_RE.test(second)) {
      const rec = await prisma.apiKey.findUnique({ where: { id: second } });
      if (!rec) {
        console.error(`未找到凭证: ${second}(用 --list 查看前缀)`);
        process.exit(1);
      }
      await revokeApiKey(rec.userId, rec.id, { actorId: actor?.id, via: 'make-agent' });
      console.log(`🚫 已撤销凭证: ${rec.prefix}… (${rec.id})`);
      return;
    }
    if (!second.startsWith('bma_') || second.length < 10) {
      console.error(
        `凭证前缀不完整: ${second}(完整前缀形如 bma_xxxxxx 共 10 字符,用 --list 查看;或直接传 keyId UUID)`,
      );
      process.exit(1);
    }
    const matches = await prisma.apiKey.findMany({
      where: { prefix: { startsWith: second } },
      orderBy: { createdAt: 'asc' },
    });
    if (matches.length === 0) {
      console.error(`未找到凭证: ${second}(用 --list 查看前缀)`);
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(
        `前缀 ${second} 匹配到 ${matches.length} 把凭证,拒绝歧义撤销。请用更长前缀或 keyId 精确指定:`,
      );
      for (const k of matches) {
        console.error(
          `  - ${k.prefix}… id=${k.id} 名称=${k.name} ${k.revokedAt ? '🚫已撤销' : '✅有效'}`,
        );
      }
      process.exit(1);
    }
    const rec = matches[0];
    await revokeApiKey(rec.userId, rec.id, { actorId: actor?.id, via: 'make-agent' });
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
