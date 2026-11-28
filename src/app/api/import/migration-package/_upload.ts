/**
 * 迁移包导入端点的共享件(非路由):上传闸门 + multipart 解析。
 * preview 与执行两端点共用;执行端不信任前端,全量重跑守卫由 importPackage 保证。
 */
import JSZip from 'jszip';

import { assertContentLengthBelow } from '@/lib/api/withRoute';
import { env } from '@/lib/env';
import { denyApiKeyCrossProject, requirePermission } from '@/lib/auth/permissions';
import { requireUser, HTTPError } from '@/lib/auth/session';
import {
  inspectPackage,
  validatePackage,
  MigrationError,
  type MigrationPackage,
  type PackageInspection,
} from '@/server/services/migrationPackage.service';

/** 单次 zip 内迁移包文件数上限(对齐批量导出的 MAX_CODES)。 */
export const MAX_ARCHIVE_ENTRIES = 500;

export interface ParsedEntry {
  name: string;
  pkg: MigrationPackage | null;
  error?: string;
  details?: string[];
  inspection?: PackageInspection;
}

export interface ParsedUpload {
  kind: 'single' | 'archive';
  entries: ParsedEntry[];
  /** 原始 FormData(执行端点从中取 ownerUserId/overwrite/allowSkew;formData 只能消费一次)。 */
  form: FormData;
}

/**
 * 导入门卫:与建项目同一动作 project:create(仅 ADMIN),走 requirePermission——
 * 机器凭证由此同时受档位与项目范围约束(此前只查角色与「指定项目范围」,
 * 管理员名下的只读/读写档凭证也能导入建项目)。
 */
export async function requireImportAdmin() {
  const user = await requireUser();
  // 指定项目范围的凭证:跨项目/无项目上下文接口一律 403(审计后拒绝,口径同统计/审计)。
  await denyApiKeyCrossProject(user, 'project:create');
  await requirePermission(user, 'project:create');
  return user;
}

async function parseOnePackage(name: string, text: string): Promise<ParsedEntry> {
  try {
    const pkg = JSON.parse(text) as MigrationPackage;
    try {
      validatePackage(pkg);
    } catch (e) {
      if (e instanceof MigrationError)
        return { name, pkg: null, error: e.message, details: e.details };
      throw e;
    }
    return { name, pkg, inspection: await inspectPackage(pkg) };
  } catch (e) {
    return {
      name,
      pkg: null,
      error: `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** 解析上传文件(.json 单包 / .zip 逐包),逐项完成 校验+只读预检;失败逐项记录。 */
export async function readUploadedPackages(req: Request): Promise<ParsedUpload> {
  assertContentLengthBelow(req, env.MAX_IMPORT_BYTES);
  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new HTTPError(400, '缺少上传文件(file 字段)');
  }
  if (/\.json$/i.test(file.name)) {
    return {
      kind: 'single',
      entries: [await parseOnePackage(file.name, await file.text())],
      form,
    };
  }
  if (!/\.zip$/i.test(file.name)) {
    throw new HTTPError(400, '仅支持 .json(单包)或 .zip(批量)文件');
  }
  if (file.size > env.MAX_IMPORT_BYTES) {
    throw new HTTPError(
      413,
      `文件 ${file.name} 超过大小上限 ${Math.floor(env.MAX_IMPORT_BYTES / 1024 / 1024)}MB`,
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new HTTPError(400, 'zip 解析失败:文件损坏或不是有效压缩包');
  }
  const names = Object.keys(zip.files)
    .filter((n) => zip.files[n]!.dir === false && /^migration-[^/]+\.json$/i.test(n))
    .sort();
  if (names.length === 0) {
    throw new HTTPError(400, 'zip 内没有迁移包文件(应为 migration-<编号>.json)');
  }
  if (names.length > MAX_ARCHIVE_ENTRIES) {
    throw new HTTPError(
      400,
      `单次最多 ${MAX_ARCHIVE_ENTRIES} 个迁移包文件,当前 ${names.length} 个`,
    );
  }
  const entries: ParsedEntry[] = [];
  for (const name of names) {
    entries.push(await parseOnePackage(name, await zip.files[name]!.async('string')));
  }
  return { kind: 'archive', entries, form };
}
