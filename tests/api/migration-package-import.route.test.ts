/**
 * 迁移包导入 UI/API 入口测试(ADR 0003 修订:导入开放,仅 ADMIN)。
 * 模式同 attachments.route.test.ts:mock requireUser 可切换 + 真实 PG。
 * 覆盖:preview(单包/zip 混合/坏文件)、execute(ownerUserId 认领/审计/冲突/覆盖/
 * 版本偏差/骨架态硬拒绝展示)、权限矩阵(USER 403、范围凭证 403)、CLI 无审计回归。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import JSZip from 'jszip';
import { v7 as uuidv7 } from 'uuid';
import { NextRequest } from 'next/server';

import { prisma } from '@/lib/prisma';
import type { UserRole } from '@prisma/client';
import {
  deleteProjectCascade,
  exportProjectPackage,
  importPackage,
  type MigrationPackage,
} from '@/server/services/migrationPackage.service';

let mockUser: {
  id: string;
  role: UserRole;
  viaApiKey?: boolean;
  keyProjectScope?: string;
  keyProjectIds?: string[];
};
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireUser: async () => mockUser,
}));

import { POST as postPreview } from '@/app/api/import/migration-package/preview/route';
import { POST as postExecute } from '@/app/api/import/migration-package/route';

let adminId: string;
let plainUserId: string;
let scopedKeyId: string;
let cleanPkg: MigrationPackage;
let skewedPkg: MigrationPackage;
let pendingPkg: MigrationPackage;
const createdProjectIds: string[] = [];

function pkgFile(pkg: MigrationPackage, name?: string): File {
  return new File(
    [`${JSON.stringify(pkg, null, 2)}\n`],
    name ?? `migration-${pkg.project.code}.json`,
    {
      type: 'application/json',
    },
  );
}

/** 克隆包并重建全部内部 ID(项目/科目/预算/单据),换编号后可作为「另一个项目」导入。 */
function freshPkg(src: MigrationPackage, code: string): MigrationPackage {
  const p = structuredClone(src);
  const map = new Map<string, string>();
  const id = (old: string) => {
    if (!map.has(old)) map.set(old, uuidv7());
    return map.get(old)!;
  };
  p.project.id = id(p.project.id);
  p.project.code = code;
  if (p.projectBudget) p.projectBudget.projectId = p.project.id;
  for (const s of p.subjects) {
    const old = s.id;
    s.id = id(old);
    if (s.parentId) s.parentId = id(s.parentId);
  }
  for (const a of p.annualBudgets) a.id = id(a.id);
  for (const s of p.subjectBudgets) {
    s.id = id(s.id);
    s.subjectId = id(s.subjectId);
  }
  for (const s of p.subjectTotalBudgets) {
    s.id = id(s.id);
    s.subjectId = id(s.subjectId);
  }
  if (p.initialApplication) p.initialApplication.id = id(p.initialApplication.id);
  for (const a of p.adjustments) {
    a.id = id(a.id);
    for (const l of a.lines) {
      l.id = id(l.id);
      if (l.subjectId) l.subjectId = id(l.subjectId);
      if (l.newSubjectParentId) l.newSubjectParentId = id(l.newSubjectParentId);
    }
  }
  for (const s of p.subjectChanges) s.id = id(s.id);
  return p;
}

async function zipFile(
  entries: { name: string; content: string }[],
  name = 'packages.zip',
): Promise<File> {
  const zip = new JSZip();
  for (const e of entries) zip.file(e.name, e.content);
  return new File([await zip.generateAsync({ type: 'arraybuffer' })], name, {
    type: 'application/zip',
  });
}

function formReq(path: string, file: File, fields: Record<string, string> = {}): NextRequest {
  const form = new FormData();
  form.append('file', file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest(`http://localhost${path}`, { method: 'POST', body: form });
}

function preview(file: File): Promise<Response> {
  return postPreview(
    formReq('/api/import/migration-package/preview', file),
    undefined,
  ) as Promise<Response>;
}

function execute(file: File, fields: Record<string, string> = {}): Promise<Response> {
  return postExecute(
    formReq('/api/import/migration-package', file, fields),
    undefined,
  ) as Promise<Response>;
}

async function seedProject(
  code: string,
  opts: { pendingAdjustment?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await prisma.project.create({ data: { id, code, name: `UI导入测试 ${code}`, ownerId: adminId } });
  await prisma.budgetSubject.create({
    data: { id: uuidv7(), projectId: id, code: 'A01', name: '设备费', level: 0, isLeaf: true },
  });
  await prisma.initialBudgetApplication.create({
    data: { id: uuidv7(), projectId: id, status: 'APPROVED', applicantId: adminId },
  });
  if (opts.pendingAdjustment) {
    await prisma.budgetAdjustment.create({
      data: {
        id: uuidv7(),
        projectId: id,
        year: 2026,
        kind: 'ADJUST',
        status: 'PENDING',
        applicantId: adminId,
      },
    });
  }
  return id;
}

beforeAll(async () => {
  await prisma.$connect();
  adminId = uuidv7();
  plainUserId = uuidv7();
  scopedKeyId = uuidv7();
  await prisma.user.createMany({
    data: [
      { id: adminId, name: `uiimp-admin-${uuidv7()}`, role: 'ADMIN' },
      { id: plainUserId, name: `uiimp-user-${uuidv7()}`, role: 'USER' },
      { id: scopedKeyId, name: `uiimp-key-${uuidv7()}`, role: 'USER' },
    ],
  });
  mockUser = { id: adminId, role: 'ADMIN' };

  // 用真实导出管线造包(删除源项目后,包即「来自别处」的跨环境包)。
  const codeClean = `UIIMP-${uuidv7()}`;
  const codeSkew = `UIIMP-${uuidv7()}`;
  const codePending = `UIIMP-${uuidv7()}`;
  const idClean = await seedProject(codeClean);
  const idSkew = await seedProject(codeSkew);
  const idPending = await seedProject(codePending, { pendingAdjustment: true });
  cleanPkg = await exportProjectPackage(
    await prisma.project.findUniqueOrThrow({ where: { id: idClean }, include: { owner: true } }),
    {},
  );
  skewedPkg = await exportProjectPackage(
    await prisma.project.findUniqueOrThrow({ where: { id: idSkew }, include: { owner: true } }),
    {},
  );
  skewedPkg.appVersion = '0.0.0';
  pendingPkg = await exportProjectPackage(
    await prisma.project.findUniqueOrThrow({ where: { id: idPending }, include: { owner: true } }),
    { force: true },
  );
  for (const id of [idClean, idSkew, idPending]) {
    await prisma.$transaction((tx) => deleteProjectCascade(tx, id));
  }
});

afterAll(async () => {
  for (const id of createdProjectIds.splice(0)) {
    await prisma.$transaction((tx) => deleteProjectCascade(tx, id)).catch(() => {});
  }
  await prisma.auditLog
    .deleteMany({ where: { operatorId: { in: [adminId, plainUserId, scopedKeyId] } } })
    .catch(() => {});
  await prisma.user
    .deleteMany({ where: { id: { in: [adminId, plainUserId, scopedKeyId] } } })
    .catch(() => {});
  await prisma.$disconnect();
});

describe('preview(只读预检)', () => {
  it('单包 json:ok 且 inspection 完整(无冲突/无版本偏差)', async () => {
    const res = await preview(pkgFile(cleanPkg));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe('single');
    expect(body.files).toHaveLength(1);
    const f = body.files[0];
    expect(f.ok).toBe(true);
    expect(f.inspection.code).toBe(cleanPkg.project.code);
    expect(f.inspection.stats.subjects).toBe(1);
    expect(f.inspection.conflict).toBeNull();
    expect(f.inspection.versionSkew).toBeNull();
  });

  it('zip:混合状态逐项标注(可导入/版本偏差/解析失败),manifest 被忽略', async () => {
    const file = await zipFile([
      { name: `migration-${cleanPkg.project.code}.json`, content: JSON.stringify(cleanPkg) },
      { name: `migration-${skewedPkg.project.code}.json`, content: JSON.stringify(skewedPkg) },
      { name: 'manifest.json', content: '{}' },
      { name: 'migration-broken.json', content: 'not-json' },
    ]);
    const res = await preview(file);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      files: { name: string; ok: boolean; error?: string; inspection?: { versionSkew: unknown } }[];
    };
    expect(body.kind).toBe('archive');
    expect(body.files).toHaveLength(3); // manifest 不参与
    const byName = new Map(body.files.map((f) => [f.name, f]));
    expect(
      byName.get(`migration-${cleanPkg.project.code}.json`)!.inspection!.versionSkew,
    ).toBeNull();
    expect(
      byName.get(`migration-${skewedPkg.project.code}.json`)!.inspection!.versionSkew,
    ).not.toBeNull();
    expect(byName.get('migration-broken.json')!.ok).toBe(false);
    expect(byName.get('migration-broken.json')!.error).toContain('JSON 解析失败');
  });

  it('同编号冲突预检:骨架态与硬拒绝可区分', async () => {
    // 先导入 cleanPkg,再预检同包 → conflict.skeleton=true。
    const exec = await execute(pkgFile(cleanPkg), { ownerUserId: plainUserId });
    expect(exec.status).toBe(200);
    createdProjectIds.push(cleanPkg.project.id);
    const res = await preview(pkgFile(cleanPkg));
    const f = (await res.json()).files[0];
    expect(f.inspection.conflict).not.toBeNull();
    expect(f.inspection.conflict.skeleton).toBe(true);

    // 给目标塞一条业务记录 → skeleton=false(硬拒绝)。
    await prisma.businessRecord.create({
      data: {
        id: uuidv7(),
        projectId: cleanPkg.project.id,
        budgetYear: 2026,
        subjectId: (
          await prisma.budgetSubject.findFirstOrThrow({ where: { projectId: cleanPkg.project.id } })
        ).id,
        amount: '1.00',
        businessDate: new Date(),
        handler: 't',
        summary: '预检硬拒绝测试',
        status: 'PLACEHOLDER',
        createdById: adminId,
      },
    });
    const res2 = await preview(pkgFile(cleanPkg));
    const f2 = (await res2.json()).files[0];
    expect(f2.inspection.conflict.skeleton).toBe(false);
    await prisma.businessRecord.deleteMany({ where: { projectId: cleanPkg.project.id } });
  });

  it('非 json/zip 文件 → 400', async () => {
    const res = await preview(new File(['x'], 'package.txt', { type: 'text/plain' }));
    expect(res.status).toBe(400);
  });
});

describe('execute(逐包独立事务)', () => {
  it('ownerUserId 认领:OWNER 成员 + 审计 action=import(operator=admin)', async () => {
    // cleanPkg 已导入且仍是骨架态(业务记录已删)→ overwrite 覆盖导入以验证认领与审计。
    const res = await execute(pkgFile(cleanPkg), { ownerUserId: plainUserId, overwrite: '1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      imported: number;
      results: {
        report: {
          owner: { mode: string; userId: string };
          userRefActions: { field: string; action: string }[];
        };
      }[];
    };
    expect(body.imported).toBe(1);
    expect(body.results[0].report.owner.mode).toBe('claimed');
    expect(body.results[0].report.owner.userId).toBe(plainUserId);

    const project = await prisma.project.findUniqueOrThrow({
      where: { code: cleanPkg.project.code },
    });
    // 同库测试:包的源 owner(adminId)在目标存在 → 按「同 ID 保留」不动,认领体现在 OWNER 成员。
    expect(project.ownerId).toBe(adminId);
    expect(
      body.results[0].report.userRefActions.find((r) => r.field === 'project.ownerId')?.action,
    ).toBe('kept');
    expect(
      await prisma.projectMember.count({ where: { projectId: project.id, userId: plainUserId } }),
    ).toBe(1);

    const audits = await prisma.auditLog.findMany({
      where: { objectId: project.id, action: 'import' },
      orderBy: { operatedAt: 'asc' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2); // 第一次导入 + 覆盖导入
    expect(audits.every((a) => a.operatorId === adminId)).toBe(true);
    expect(audits[audits.length - 1].beforeData).not.toBeNull(); // 覆盖导入带 before 摘要
    expect((audits[0].afterData as { source?: string }).source).toBe('migration-package');
  });

  it('版本偏差:不勾 allowSkew 失败,勾选后导入成功', async () => {
    const no = await execute(pkgFile(skewedPkg));
    expect(no.status).toBe(400);
    const bodyNo = await no.json();
    expect(bodyNo.results[0].status).toBe('failed');
    expect(bodyNo.results[0].reason).toContain('版本不一致');

    const yes = await execute(pkgFile(skewedPkg), { allowSkew: '1' });
    expect(yes.status).toBe(200);
    createdProjectIds.push(skewedPkg.project.id);
  });

  it('包内 PENDING 正常导入(warning 提示)', async () => {
    const res = await execute(pkgFile(pendingPkg), { ownerUserId: plainUserId });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].report.warnings.join(' ')).toContain('PENDING');
    createdProjectIds.push(pendingPkg.project.id);
  });

  it('CLI 路径(无 actor)不产生审计行', async () => {
    const code = `UIIMP-${uuidv7()}`;
    const pkg = freshPkg(cleanPkg, code);
    await importPackage(pkg, {});
    const project = await prisma.project.findUniqueOrThrow({ where: { code } });
    createdProjectIds.push(project.id);
    expect(await prisma.auditLog.count({ where: { objectId: project.id, action: 'import' } })).toBe(
      0,
    );
  });

  it('zip 混合:一包失败不牵连其余,全部失败 400', async () => {
    // cleanPkg 已存在(不勾覆盖会失败)+ skewedPkg 已存在(会失败) → 全失败 400。
    const all = await execute(
      await zipFile([
        { name: `migration-${cleanPkg.project.code}.json`, content: JSON.stringify(cleanPkg) },
        { name: `migration-${skewedPkg.project.code}.json`, content: JSON.stringify(skewedPkg) },
      ]),
    );
    expect(all.status).toBe(400);
    const body = await all.json();
    expect(body.results.every((r: { status: string }) => r.status === 'failed')).toBe(true);

    // 再造一个新包混入 → 混合结果 200,仅新包成功。
    const code = `UIIMP-${uuidv7()}`;
    const pkg = freshPkg(cleanPkg, code);
    const mixed = await execute(
      await zipFile([
        { name: `migration-${cleanPkg.project.code}.json`, content: JSON.stringify(cleanPkg) },
        { name: `migration-${code}.json`, content: JSON.stringify(pkg) },
      ]),
    );
    expect(mixed.status).toBe(200);
    const mixedBody = await mixed.json();
    expect(mixedBody.imported).toBe(1);
    createdProjectIds.push(pkg.project.id);
  });
});

describe('权限矩阵', () => {
  it('普通 USER 403;指定项目范围凭证 403(两端点)', async () => {
    mockUser = { id: plainUserId, role: 'USER' };
    expect((await preview(pkgFile(cleanPkg))).status).toBe(403);
    expect((await execute(pkgFile(cleanPkg))).status).toBe(403);
    mockUser = {
      id: scopedKeyId,
      role: 'USER',
      viaApiKey: true,
      keyProjectScope: 'selected',
      keyProjectIds: [uuidv7()],
    };
    expect((await preview(pkgFile(cleanPkg))).status).toBe(403);
    expect((await execute(pkgFile(cleanPkg))).status).toBe(403);
    mockUser = { id: adminId, role: 'ADMIN' };
  });
});
