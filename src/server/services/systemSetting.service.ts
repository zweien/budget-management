import { Prisma, type User } from '@prisma/client';
import { ZodError } from 'zod';

import { prisma } from '@/lib/prisma';
import { HTTPError } from '@/lib/auth/session';
import {
  LOGO_SLOTS,
  LOGO_SLOT_LABELS,
  mergeSystemSettings,
  systemSettingsPatchSchema,
  type LogoMap,
  type LogoSlot,
  type SystemSettings,
  type SystemSettingsPatch,
  type SystemSettingsSnapshot,
} from '@/lib/system-settings';
import { validateLogo, type LogoType } from '@/lib/system-logo';
import { recordAudit } from '@/server/audit/interceptor';

/**
 * 系统设置(ADR 0004;CONTEXT.md「系统设置」)。
 * - 读:匿名可读的展示类设置。生效值 = 出厂默认 ⊕ 库里显式保存过的键;没有行即全部默认。
 * - 写:仅 ADMIN 登录会话,拒绝一切 Bearer 凭证(含 attended)——登录页的文案与标志由设置
 *   驱动,被提示词注入的 agent 若能改它就能伪造登录页外观。标量与标志在同一事务落库并写审计。
 * - 每张设置卡片只提交自己的键:服务端按键合并,不同卡片互不覆盖。
 * 红线与边界:这里只放「匿名可见无害」的展示类设置;敏感配置不得进入(见 ADR 0004)。
 */

/** 设置单例行的 id(全实例一行)。 */
export const SYSTEM_SETTING_ID = 'default';

/** 审计对象类型与动作(操作日志页「对象类型」筛选项同步)。 */
export const SETTINGS_AUDIT_OBJECT_TYPE = 'system_settings';
export const SETTINGS_AUDIT_ACTION = 'settings.update';

/**
 * 进程内缓存:页面外壳每次渲染都要读设置(标签页标题/侧边栏/默认主题),不走每请求查库。
 * 写入即时失效;TTL 只兜「带外改库」与多进程部署这类不经本进程的变更。
 * 缓存挂在 globalThis 上:Next 按路由分别打包服务端代码,同一模块在写接口与页面渲染里
 * 是不同实例、模块级变量互不相通——挂全局后,写接口的失效才对页面渲染可见
 * (与 lib/prisma 的单例同款手法)。
 */
const CACHE_TTL_MS = 5_000;

interface SettingsCache {
  value: SystemSettingsSnapshot;
  expiresAt: number;
}

const globalForSettings = globalThis as unknown as {
  systemSettingsCache?: SettingsCache | null;
};

type SettingsOperator = Pick<User, 'id' | 'role'> & {
  viaApiKey?: boolean;
  unattended?: boolean;
};

export type LogoOperation = { action: 'set'; bytes: Buffer } | { action: 'clear' };
/** 本次提交要改动的标志位(未列出的位保持不变)。 */
export type LogoOperations = Partial<Record<LogoSlot, LogoOperation>>;

type PreparedLogo = { action: 'set'; bytes: Buffer; contentType: LogoType } | { action: 'clear' };

/** 仅管理员登录会话可改(对齐用户管理/凭证管理红线)。 */
function assertSettingsAdmin(user: SettingsOperator): void {
  if (user.viaApiKey) {
    throw new HTTPError(403, '系统设置仅限登录会话修改,机器凭证不得调用');
  }
  if (user.role !== 'ADMIN') {
    throw new HTTPError(403, '仅管理员可修改系统设置');
  }
}

export function isLogoSlot(value: string): value is LogoSlot {
  return (LOGO_SLOTS as readonly string[]).includes(value);
}

/** 标志地址:带版本号(更新时间戳),内容一变地址即变,可放心长缓存。 */
function logoUrl(slot: LogoSlot, updatedAt: Date): string {
  return `/api/settings/logos/${slot}?v=${updatedAt.getTime()}`;
}

function toPlainObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 与 withRoute 同款的 Zod 报错文案(`路径: 消息`),服务层直调的调用方拿到的也是 422。 */
function zodToHttpError(error: ZodError): HTTPError {
  const first = error.issues[0];
  return new HTTPError(
    422,
    first ? `${first.path.join('.') || '参数'}: ${first.message}` : '参数校验失败',
  );
}

async function loadSystemSettings(): Promise<SystemSettingsSnapshot> {
  const [row, logoRows] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { id: SYSTEM_SETTING_ID } }),
    // 只取元数据:读设置不带出标志字节。
    prisma.systemLogo.findMany({
      select: { key: true, contentType: true, sizeBytes: true, updatedAt: true },
    }),
  ]);
  const logos: LogoMap = { standard: null, dark: null, compact: null };
  for (const logo of logoRows) {
    if (isLogoSlot(logo.key)) {
      logos[logo.key] = {
        url: logoUrl(logo.key, logo.updatedAt),
        contentType: logo.contentType,
        sizeBytes: logo.sizeBytes,
      };
    }
  }
  return { ...mergeSystemSettings(toPlainObject(row?.settings)), logos };
}

/** 当前生效的系统设置(含标志元数据)。 */
export async function getSystemSettings(): Promise<SystemSettingsSnapshot> {
  const cached = globalForSettings.systemSettingsCache;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await loadSystemSettings();
  globalForSettings.systemSettingsCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/** 写入后调用:让本进程(所有模块实例)立即读到新值——其他人下次刷新/跳转即生效。 */
export function invalidateSystemSettingsCache(): void {
  globalForSettings.systemSettingsCache = null;
}

/**
 * 页面外壳用的容错读取:库不可达时回落出厂默认,不让整站外壳随设置表一起挂掉。
 * 只用于渲染路径;管理接口走 getSystemSettings,读不到就如实报错。
 */
export async function getSystemSettingsSafe(): Promise<SystemSettingsSnapshot> {
  try {
    return await getSystemSettings();
  } catch (e) {
    console.error('[system-settings] 读取失败,暂按内置默认渲染', e);
    return {
      ...mergeSystemSettings(null),
      logos: { standard: null, dark: null, compact: null },
    };
  }
}

function parsePatch(input: unknown): SystemSettingsPatch {
  const parsed = systemSettingsPatchSchema.safeParse(input);
  if (!parsed.success) throw zodToHttpError(parsed.error);
  const patch = parsed.data;
  // 显式剔除 undefined:后续的合并与 diff 只看本次真正提交的键。
  for (const key of Object.keys(patch) as (keyof SystemSettingsPatch)[]) {
    if (patch[key] === undefined) delete patch[key];
  }
  return patch;
}

/** 标志位逐个校验(大小/真实类型/像素上限/SVG 禁止内容),失败按校验结果的状态码拒绝。 */
function prepareLogos(ops: LogoOperations): Partial<Record<LogoSlot, PreparedLogo>> {
  const prepared: Partial<Record<LogoSlot, PreparedLogo>> = {};
  for (const slot of LOGO_SLOTS) {
    const op = ops[slot];
    if (!op) continue;
    if (op.action === 'clear') {
      prepared[slot] = op;
      continue;
    }
    const result = validateLogo(op.bytes);
    if (!result.ok) {
      throw new HTTPError(result.status, `${LOGO_SLOT_LABELS[slot]}:${result.message}`);
    }
    prepared[slot] = { action: 'set', bytes: op.bytes, contentType: result.contentType };
  }
  return prepared;
}

/** 取对象里指定的键(审计只记前后有差异的部分)。 */
function pick<T extends object>(source: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) out[key] = source[key];
  return out;
}

function logoSummary(rows: Array<{ key: string; contentType: string; sizeBytes: number }>) {
  const summary: Record<LogoSlot, { contentType: string; sizeBytes: number } | null> = {
    standard: null,
    dark: null,
    compact: null,
  };
  for (const row of rows) {
    if (isLogoSlot(row.key))
      summary[row.key] = { contentType: row.contentType, sizeBytes: row.sizeBytes };
  }
  return summary;
}

/**
 * 保存系统设置:按键合并(未提交的键不动),标量与标志同一事务,有变化才写一条审计。
 * 审计记标量的前后值;标志只记类型与大小,不记字节。
 */
export async function updateSystemSettings(
  operator: SettingsOperator,
  input: unknown,
  logoOps: LogoOperations = {},
): Promise<SystemSettingsSnapshot> {
  assertSettingsAdmin(operator);
  const patch = parsePatch(input);
  const logos = prepareLogos(logoOps);
  const keys = Object.keys(patch) as (keyof SystemSettings)[];

  await prisma.$transaction(async (tx) => {
    const row = await tx.systemSetting.findUnique({ where: { id: SYSTEM_SETTING_ID } });
    const before = mergeSystemSettings(toPlainObject(row?.settings));
    const logoRows = await tx.systemLogo.findMany({
      select: { key: true, contentType: true, sizeBytes: true },
    });
    const beforeLogos = logoSummary(logoRows);

    // 该标志位在本次保存之后是否存在。
    const presentAfter = (slot: LogoSlot): boolean => {
      const op = logos[slot];
      if (op?.action === 'set') return true;
      if (op?.action === 'clear') return false;
      return beforeLogos[slot] !== null;
    };
    // 深色主题版与窄栏图标版依附于标准版:没有标准版它们无处回退,也没有对应的展示位。
    if (!presentAfter('standard') && (presentAfter('dark') || presentAfter('compact'))) {
      throw new HTTPError(422, '深色主题版与窄栏图标版依附于标准版,请先设置标准版或一并清除');
    }

    if (keys.length > 0) {
      // JSONB 键级合并:不同卡片并发保存互不覆盖(整行读改写会丢掉对方的键)。
      const stamp = new Date();
      const settingsJson = JSON.stringify(patch);
      await tx.$queryRaw(Prisma.sql`
        INSERT INTO "system_settings" ("id", "settings", "updated_at")
        VALUES (${SYSTEM_SETTING_ID}, ${settingsJson}::jsonb, ${stamp})
        ON CONFLICT ("id") DO UPDATE
          SET "settings" = "system_settings"."settings" || EXCLUDED."settings",
              "updated_at" = ${stamp}
      `);
    }

    const afterLogos = { ...beforeLogos };
    for (const slot of LOGO_SLOTS) {
      const op = logos[slot];
      if (op?.action === 'set') {
        await tx.systemLogo.upsert({
          where: { key: slot },
          create: {
            key: slot,
            contentType: op.contentType,
            sizeBytes: op.bytes.byteLength,
            data: op.bytes,
          },
          update: {
            contentType: op.contentType,
            sizeBytes: op.bytes.byteLength,
            data: op.bytes,
          },
        });
        afterLogos[slot] = { contentType: op.contentType, sizeBytes: op.bytes.byteLength };
      } else if (op?.action === 'clear') {
        await tx.systemLogo.deleteMany({ where: { key: slot } });
        afterLogos[slot] = null;
      }
    }

    const after: SystemSettings = { ...before, ...patch };
    const changedKeys = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const changedLogos = LOGO_SLOTS.filter(
      (slot) =>
        logos[slot] !== undefined &&
        JSON.stringify(beforeLogos[slot]) !== JSON.stringify(afterLogos[slot]),
    );
    if (changedKeys.length === 0 && changedLogos.length === 0) return;

    await recordAudit(tx, {
      objectType: SETTINGS_AUDIT_OBJECT_TYPE,
      objectId: SYSTEM_SETTING_ID,
      action: SETTINGS_AUDIT_ACTION,
      operatorId: operator.id,
      before: {
        ...pick(before, changedKeys),
        ...(changedLogos.length ? { logos: pick(beforeLogos, changedLogos) } : {}),
      },
      after: {
        ...pick(after, changedKeys),
        ...(changedLogos.length ? { logos: pick(afterLogos, changedLogos) } : {}),
      },
    });
  });

  invalidateSystemSettingsCache();
  return getSystemSettings();
}

/** 取标志字节(标志路由输出用;不存在即 404)。 */
export async function getSystemLogo(slot: string): Promise<{
  data: Buffer;
  contentType: string;
  sizeBytes: number;
  updatedAt: Date;
}> {
  if (!isLogoSlot(slot)) throw new HTTPError(404, '标志不存在');
  const row = await prisma.systemLogo.findUnique({ where: { key: slot } });
  if (!row) throw new HTTPError(404, '标志不存在');
  return {
    data: row.data,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt,
  };
}
