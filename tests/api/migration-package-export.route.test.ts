/**
 * 迁移包导出 UI/API 入口测试(ADR 0003 修订:导出开放 HTTP)。
 * 模式同 tests/api/attachments.route.test.ts:mock requireUser + 真实 PG 夹具,
 * 直调 route 的 GET。覆盖:单项目(200/404/PENDING 409→acknowledged 放行)、
 * 批量 zip+manifest(PENDING 跳过/包含/未知编号/全失败 400/参数校验)、
 * 指定项目范围凭证在批量端点 403 且单项目端点不受影响。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import JSZip from 'jszip';
import { v7 as uuidv7 } from 'uuid';
import { NextRequest } from 'next/server';

import { prisma } from '@/lib/prisma';
import type { UserRole } from '@prisma/client';
import { deleteProjectCascade } from '@/server/services/migrationPackage.service';

// requireUser 可切换(mock 用户),其余导出(如 HTTPError)保持原实现。
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

import { GET as getSingle } from '@/app/api/projects/[id]/export/migration-package/route';
import { GET as getBatch } from '@/app/api/export/migration-packages/route';

let adminId: string;
let viewerId: string;
let scopedKeyId: string;
let cleanCode: string;
let pendingCode: string;
let cleanId: string;
let pendingId: string;

function callSingle(id: string, query = ''): Promise<Response> {
  return getSingle(
    new NextRequest(`http://localhost/api/projects/${id}/export/migration-package${query}`),
    { params: Promise.resolve({ id }) },
  ) as Promise<Response>;
}

function callBatch(query: string): Promise<Response> {
  return getBatch(
    new NextRequest(`http://localhost/api/export/migration-packages${query}`),
    undefined,
  ) as Promise<Response>;
}

async function unzip(res: Response): Promise<JSZip> {
  return JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
}

async function seedProject(
  code: string,
  opts: { pendingAdjustment?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  await prisma.project.create({ data: { id, code, name: `UI导出测试 ${code}`, ownerId: adminId } });
  if (opts.pendingAdjustment) {
    await prisma.initialBudgetApplication.create({
      data: { id: uuidv7(), projectId: id, status: 'APPROVED', applicantId: adminId },
    });
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
  viewerId = uuidv7();
  scopedKeyId = uuidv7();
  await prisma.user.createMany({
    data: [
      { id: adminId, name: `uiexp-admin-${uuidv7().slice(0, 8)}`, role: 'ADMIN' },
      { id: viewerId, name: `uiexp-viewer-${uuidv7().slice(0, 8)}`, role: 'USER' },
      { id: scopedKeyId, name: `uiexp-key-${uuidv7().slice(0, 8)}`, role: 'USER' },
    ],
  });
  // 注意不能用 uuidv7().slice(0,8) 当编号:前缀是毫秒时间戳,相邻调用同毫秒会撞码。
  cleanCode = `UIEXP-${uuidv7()}`;
  pendingCode = `UIEXP-${uuidv7()}`;
  cleanId = await seedProject(cleanCode);
  pendingId = await seedProject(pendingCode, { pendingAdjustment: true });
  mockUser = { id: adminId, role: 'ADMIN' };
});

afterAll(async () => {
  for (const id of [cleanId, pendingId]) {
    if (id) await prisma.$transaction((tx) => deleteProjectCascade(tx, id)).catch(() => {});
  }
  await prisma.auditLog
    .deleteMany({ where: { operatorId: { in: [adminId, viewerId, scopedKeyId] } } })
    .catch(() => {});
  await prisma.user
    .deleteMany({ where: { id: { in: [adminId, viewerId, scopedKeyId] } } })
    .catch(() => {});
  await prisma.$disconnect();
});

describe('单项目导出 GET /api/projects/:id/export/migration-package', () => {
  it('200:envelope、文件名与 no-store', async () => {
    const res = await callSingle(cleanId);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(encodeURIComponent(cleanCode));
    const pkg = await res.json();
    expect(pkg.formatVersion).toBe(1);
    expect(pkg.kind).toBe('budget.migration-package');
    expect(pkg.project.code).toBe(cleanCode);
  });

  it('404:项目不存在', async () => {
    const res = await callSingle(uuidv7());
    expect(res.status).toBe(404);
  });

  it('普通 USER(project:view)同样可导出', async () => {
    mockUser = { id: viewerId, role: 'USER' };
    const res = await callSingle(cleanId);
    expect(res.status).toBe(200);
    mockUser = { id: adminId, role: 'ADMIN' };
  });

  it('PENDING 守卫:409 + 在途单清单;pendingAcknowledged=1 放行', async () => {
    const res = await callSingle(pendingId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; details?: string[] };
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details!.length).toBeGreaterThan(0);
    expect(body.details![0]).toContain('待审批');

    const ok = await callSingle(pendingId, '?pendingAcknowledged=1');
    expect(ok.status).toBe(200);
    const pkg = await ok.json();
    expect(pkg.provenance.pending.adjustments).toHaveLength(1);
  });
});

describe('批量导出 GET /api/export/migration-packages', () => {
  it('默认跳过 PENDING 项目:zip 含干净项目 + manifest 记录跳过', async () => {
    const res = await callBatch(`?codes=${encodeURIComponent(`${cleanCode},${pendingCode}`)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    const zip = await unzip(res);
    expect(zip.file(`migration-${cleanCode}.json`)).not.toBeNull();
    expect(zip.file(`migration-${pendingCode}.json`)).toBeNull();
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.exported).toEqual([cleanCode]);
    expect(manifest.skippedPending.map((s: { code: string }) => s.code)).toEqual([pendingCode]);
  });

  it('includePending=1:在途项目随包带出', async () => {
    const res = await callBatch(
      `?codes=${encodeURIComponent(`${cleanCode},${pendingCode}`)}&includePending=1`,
    );
    expect(res.status).toBe(200);
    const zip = await unzip(res);
    expect(zip.file(`migration-${pendingCode}.json`)).not.toBeNull();
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.includePending).toBe(true);
    expect(manifest.exported).toHaveLength(2);
  });

  it('未知编号进 manifest.failed;全部失败返回 400', async () => {
    const res = await callBatch(`?codes=${encodeURIComponent(`${cleanCode},NOPE-404`)}`);
    expect(res.status).toBe(200);
    const manifest = JSON.parse(await (await unzip(res)).file('manifest.json')!.async('string'));
    expect(manifest.failed).toEqual([{ code: 'NOPE-404', reason: '项目不存在' }]);

    const all = await callBatch('?codes=NOPE-404');
    expect(all.status).toBe(400);
    const body = (await all.json()) as { details?: string[] };
    expect(body.details?.[0]).toContain('NOPE-404');
  });

  it('参数校验:缺 codes / 重复编号 → 400', async () => {
    expect((await callBatch('')).status).toBe(400);
    expect(
      (await callBatch(`?codes=${encodeURIComponent(`${cleanCode},${cleanCode}`)}`)).status,
    ).toBe(400);
  });

  it('指定项目范围的 API 凭证:批量端点 403;范围内项目单端点放行、范围外 403', async () => {
    mockUser = {
      id: scopedKeyId,
      role: 'USER',
      viaApiKey: true,
      keyProjectScope: 'selected',
      keyProjectIds: [cleanId],
    };
    // 批量是跨项目端点:范围凭证一律拒绝(与统计/审计全量同惯例)。
    const batch = await callBatch(`?codes=${encodeURIComponent(cleanCode)}`);
    expect(batch.status).toBe(403);
    // 单项目端点走行级 project:view:范围内放行、范围外按收窄拒绝。
    const inScope = await callSingle(cleanId);
    expect(inScope.status).toBe(200);
    const outScope = await callSingle(pendingId, '?pendingAcknowledged=1');
    expect(outScope.status).toBe(403);
    mockUser = { id: adminId, role: 'ADMIN' };
  });
});
