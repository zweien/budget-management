import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { GET as downloadFile } from '@/app/api/projects/[id]/imports/[batchId]/file/route';

// mock 鉴权:下载走 project:view,这里以 ADMIN 直行(权限矩阵由服务层测试覆盖)。
vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/session')>)();
  return {
    ...actual,
    requireUser: async () =>
      ({ id: 'ifr-route-admin', role: UserRole.ADMIN, name: 'admin' }) as never,
  };
});

/** 下载路由:二进制回包 + Content-Disposition(RFC 5987 中文文件名)+ 404 形态。 */
describe('import file download route(real PG)', () => {
  const userId = uuidv7();
  const projectId = uuidv7();
  const fileBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x05]);
  let batchId = '';

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: userId, name: 'ifr-route', role: UserRole.ADMIN },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        code: `IFR-R-${uuidv7()}`,
        name: 'ifr-route',
        ownerId: userId,
      },
    });
    batchId = uuidv7();
    await prisma.importBatch.create({
      data: {
        id: batchId,
        projectId,
        fileName: '财务结算单 2026-10.xlsx',
        templateVersion: 'settlement-3.0',
        creatorId: userId,
        fileData: fileBytes,
        fileSizeBytes: fileBytes.length,
      },
    });
  });

  afterAll(async () => {
    await prisma.importBatch.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  function get(id: string, bid: string) {
    return downloadFile(new Request('http://localhost') as never, {
      params: Promise.resolve({ id, batchId: bid }),
    });
  }

  it('留存批次 → 200 + xlsx MIME + RFC 5987 文件名 + 原字节', async () => {
    const res = await get(projectId, batchId);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toContain('attachment; filename="import.xlsx"');
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent('财务结算单 2026-10.xlsx')}`,
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(fileBytes)).toBe(true);
  });

  it('不存在的批次 → 404 JSON 错误信封', async () => {
    const res = await get(projectId, uuidv7());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.requestId).toBeTruthy();
  });
});
