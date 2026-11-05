import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { HTTPError } from '@/lib/auth/session';
import { getImportFile, listImportBatches } from '@/server/services/settlementImport.service';

/**
 * 上传原件留存:批次创建带 fileData → 列表暴露 fileSizeBytes(不拉 bytea),
 * getImportFile 校验归属/留存;历史批次(null)→ 404。
 */
describe('import file retention (real PG)', () => {
  const adminId = uuidv7();
  const viewerId = uuidv7();
  const projectId = uuidv7();
  const otherProjectId = uuidv7();
  // 固定字面字节做断言(避开生成器输出差异)。
  const fileBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);
  let retainedBatchId = '';
  let legacyBatchId = '';
  let crossBatchId = '';
  let unmappedBatchId = '';

  const admin = { id: adminId, role: UserRole.ADMIN };
  const viewer = { id: viewerId, role: UserRole.USER };
  // selected 项目范围凭证:仅授权本项目(codex 评审 P1 范围闸)。
  const scopedKey = {
    id: adminId,
    role: UserRole.USER,
    viaApiKey: true,
    keyProjectScope: 'selected',
    keyProjectIds: [projectId],
  };

  beforeAll(async () => {
    await prisma.user.create({ data: { id: adminId, name: 'ifr-admin', role: UserRole.ADMIN } });
    await prisma.user.create({ data: { id: viewerId, name: 'ifr-viewer', role: UserRole.USER } });
    await prisma.project.create({
      data: { id: projectId, code: `IFR-${uuidv7()}`, name: 'ifr', ownerId: adminId },
    });
    await prisma.project.create({
      data: { id: otherProjectId, code: `IFR2-${uuidv7()}`, name: 'ifr2', ownerId: adminId },
    });
    retainedBatchId = uuidv7();
    await prisma.importBatch.create({
      data: {
        id: retainedBatchId,
        projectId,
        fileName: '结算单-2026.xlsx',
        templateVersion: 'settlement-2.0',
        creatorId: adminId,
        fileData: fileBytes,
        fileSizeBytes: fileBytes.length,
      },
    });
    // v3 多项目批次:一行映射到本项目,一行映射到其他项目(范围闸拒绝用)。
    crossBatchId = uuidv7();
    await prisma.importBatch.create({
      data: {
        id: crossBatchId,
        projectId,
        fileName: '财务结算单-多项目.xlsx',
        templateVersion: 'settlement-3.0',
        creatorId: adminId,
        fileData: fileBytes,
        fileSizeBytes: fileBytes.length,
        rows: {
          create: [
            {
              id: uuidv7(),
              rowNo: 2,
              parsedData: {
                targetProjectId: projectId,
                fileProjectName: '本项目行',
              } as unknown as Prisma.InputJsonValue,
              validationStatus: 'valid',
            },
            {
              id: uuidv7(),
              rowNo: 3,
              parsedData: {
                targetProjectId: otherProjectId,
                fileProjectName: '其他项目行',
              } as unknown as Prisma.InputJsonValue,
              validationStatus: 'valid',
            },
          ],
        },
      },
    });
    // v3 未映射批次:有项目名但未映射到具体项目(范围闸「无法证明归属」拒绝用)。
    unmappedBatchId = uuidv7();
    await prisma.importBatch.create({
      data: {
        id: unmappedBatchId,
        projectId,
        fileName: '财务结算单-未映射.xlsx',
        templateVersion: 'settlement-3.0',
        creatorId: adminId,
        fileData: fileBytes,
        fileSizeBytes: fileBytes.length,
        rows: {
          create: {
            id: uuidv7(),
            rowNo: 2,
            parsedData: {
              targetProjectId: null,
              fileProjectName: '待人工映射的项目',
            } as unknown as Prisma.InputJsonValue,
            validationStatus: 'error',
          },
        },
      },
    });
    legacyBatchId = uuidv7();
    await prisma.importBatch.create({
      data: {
        id: legacyBatchId,
        projectId,
        fileName: '历史批次.xlsx',
        templateVersion: 'settlement-1.0',
        creatorId: adminId,
      },
    });
  });

  afterAll(async () => {
    // 范围闸拒绝会写 apikey.denied 审计(挂在两个项目上),一并清理。
    await prisma.auditLog.deleteMany({
      where: { projectId: { in: [projectId, otherProjectId] } },
    });
    await prisma.importRow.deleteMany({
      where: { batchId: { in: [crossBatchId, unmappedBatchId] } },
    });
    await prisma.importBatch.deleteMany({ where: { projectId } });
    await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, viewerId] } } });
    await prisma.$disconnect();
  });

  it('getImportFile:留存批次返回原字节与文件名', async () => {
    const { fileName, data } = await getImportFile(retainedBatchId, projectId, admin);
    expect(fileName).toBe('结算单-2026.xlsx');
    expect(data.equals(fileBytes)).toBe(true);
  });

  it('getImportFile:全局只读 USER 亦可下载(与附件下载同权)', async () => {
    const { data } = await getImportFile(retainedBatchId, projectId, viewer);
    expect(data.length).toBe(fileBytes.length);
  });

  it('getImportFile:历史批次(未留存)→ 404', async () => {
    await expect(getImportFile(legacyBatchId, projectId, admin)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('未留存'),
    });
  });

  it('getImportFile:批次不属于该项目 → 404(不泄露存在性)', async () => {
    await expect(getImportFile(retainedBatchId, otherProjectId, admin)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('listImportBatches:fileSizeBytes 表达留存存在性', async () => {
    const items = await listImportBatches(projectId, admin);
    const byId = new Map(items.map((b) => [b.batchId, b]));
    expect(byId.get(retainedBatchId)?.fileSizeBytes).toBe(fileBytes.length);
    expect(byId.get(legacyBatchId)?.fileSizeBytes).toBeNull();
  });

  it('HTTPError 形态(status/message)可直接被 withRoute 转换', async () => {
    const err = await getImportFile(legacyBatchId, projectId, admin).catch((e) => e);
    expect(err).toBeInstanceOf(HTTPError);
  });

  it('范围闸:selected 凭证下载无映射行的批次(目标全在授权内)→ 放行', async () => {
    const { data } = await getImportFile(retainedBatchId, projectId, scopedKey);
    expect(data.equals(fileBytes)).toBe(true);
  });

  it('范围闸:v3 行映射到授权外项目 → 403(不泄露其余项目数据)', async () => {
    await expect(getImportFile(crossBatchId, projectId, scopedKey)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('凭证未授权访问该项目'),
    });
  });

  it('范围闸:v3 存在未映射项目名的行 → 403(无法证明归属)', async () => {
    await expect(getImportFile(unmappedBatchId, projectId, scopedKey)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('未映射'),
    });
  });

  it('范围闸:all 范围凭证不受影响', async () => {
    const allScopeKey = {
      id: adminId,
      role: UserRole.USER,
      viaApiKey: true,
      keyProjectScope: 'all',
    };
    const { data } = await getImportFile(crossBatchId, projectId, allScopeKey);
    expect(data.equals(fileBytes)).toBe(true);
  });
});
