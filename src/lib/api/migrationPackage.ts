/**
 * 迁移包导出的前端下载链路(ADR 0003;UI 入口,产物与 CLI 同构)。
 *
 * - 单项目:默认先无参导出;服务端 409 + details(在途单清单)时返回 { pending },
 *   由调用方弹确认后带 pendingAcknowledged=1 重发(等价 CLI --force)。
 * - 批量:zip 容器(每项目一个 migration-<编号>.json + manifest.json);下载前用
 *   JSZip 读出 manifest 供调用方 toast 统计(成功/跳过/失败)——列表页无 PENDING
 *   预检,manifest 即结果事实源。
 */
import JSZip from 'jszip';

import { fetchFile, HttpFileError, saveBlob } from './client';

export type SingleExportResult = { ok: true } | { pending: string[] };

export async function exportMigrationPackage(
  projectId: string,
  acknowledged: boolean,
): Promise<SingleExportResult> {
  const path =
    `/api/projects/${projectId}/export/migration-package` +
    (acknowledged ? '?pendingAcknowledged=1' : '');
  try {
    const { blob, filename } = await fetchFile(path);
    await saveBlob(blob, filename ?? `migration-${projectId}.json`);
    return { ok: true };
  } catch (e) {
    if (e instanceof HttpFileError && e.status === 409) {
      const details = (e.body as { details?: unknown } | null)?.details;
      return { pending: Array.isArray(details) ? details.map(String) : [] };
    }
    throw e;
  }
}

export interface MigrationPackagesManifest {
  exported: string[];
  skippedPending: { code: string; items: string[] }[];
  failed: { code: string; reason: string }[];
}

export async function exportMigrationPackages(
  codes: string[],
  includePending: boolean,
): Promise<MigrationPackagesManifest> {
  if (codes.length === 0) throw new Error('未选择任何项目');
  const path =
    `/api/export/migration-packages?codes=${encodeURIComponent(codes.join(','))}` +
    (includePending ? '&includePending=1' : '');
  const { blob, filename } = await fetchFile(path);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const manifestFile = zip.file('manifest.json');
  const manifest: MigrationPackagesManifest = manifestFile
    ? JSON.parse(await manifestFile.async('string'))
    : { exported: [], skippedPending: [], failed: [] };
  await saveBlob(blob, filename ?? 'migration-packages.zip');
  return manifest;
}
