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

import { bootstrapMockUser, fetchFile, HttpFileError, saveBlob } from './client';

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

// ---------- 导入(两阶段无状态:预览与执行重传同一 File;仅 ADMIN) ----------

/** 与包内 PackageInspection 对应的预检结果(服务端只读检查)。 */
export interface MigrationPackageInspection {
  code: string;
  name: string;
  budgetMode: string;
  exportedAt: string;
  stats: Record<string, number>;
  versionSkew: { pkgAppVersion: string; currentAppVersion: string } | null;
  conflict: {
    existing: { id: string; code: string; name: string; archived: boolean };
    skeleton: boolean;
    memberCount: number;
    recordCount: number;
    receiptCount: number;
    importBatchCount: number;
  } | null;
  pendingInPackage: boolean;
}

export interface MigrationImportPreview {
  kind: 'single' | 'archive';
  files: { name: string; ok: boolean; error?: string; inspection?: MigrationPackageInspection }[];
}

export interface MigrationImportResult {
  code: string | null;
  name: string | null;
  status: 'imported' | 'failed';
  reason?: string;
  report?: {
    projectCode: string;
    owner: { mode: string; userName: string };
    replacedExisting: boolean;
    warnings: string[];
    summaryCheck: { lines: string[]; fixed: boolean };
  };
}

/** multipart 上传共用封装(仿 imports 页 uploadExcel:原生 fetch + mock header)。 */
async function postFormData<T>(path: string, form: FormData): Promise<T> {
  const mockUserId = await bootstrapMockUser();
  const res = await fetch(path, {
    method: 'POST',
    headers: mockUserId ? { 'x-mock-user-id': mockUserId } : {},
    body: form,
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `请求失败 (${res.status})`);
  }
  return body as T;
}

export function previewMigrationImport(file: File): Promise<MigrationImportPreview> {
  const form = new FormData();
  form.append('file', file);
  return postFormData('/api/import/migration-package/preview', form);
}

export function executeMigrationImport(
  file: File,
  opts: { ownerUserId?: string; overwrite: boolean; allowSkew: boolean },
): Promise<{ imported: number; results: MigrationImportResult[] }> {
  const form = new FormData();
  form.append('file', file);
  if (opts.ownerUserId) form.append('ownerUserId', opts.ownerUserId);
  if (opts.overwrite) form.append('overwrite', '1');
  if (opts.allowSkew) form.append('allowSkew', '1');
  return postFormData('/api/import/migration-package', form);
}
