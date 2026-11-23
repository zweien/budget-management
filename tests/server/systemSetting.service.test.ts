import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { DEFAULT_SYSTEM_SETTINGS } from '@/lib/system-settings';
import {
  SETTINGS_AUDIT_ACTION,
  SETTINGS_AUDIT_OBJECT_TYPE,
  SYSTEM_SETTING_ID,
  getSystemLogo,
  getSystemSettings,
  getSystemSettingsSafe,
  invalidateSystemSettingsCache,
  updateSystemSettings,
} from '@/server/services/systemSetting.service';
import { pngBytes, svgBytes } from '../helpers/logo-fixtures';

/**
 * 系统设置服务集成测试(直连真实 PG):
 * 出厂默认、按键合并、权限红线(非管理员 / Bearer 403)、校验 422、审计(只记差异、
 * 标志不记字节)、标志入库/依附规则/校验、缓存随写入失效、库不可达时的容错读取。
 * 设置是全实例单例:每个用例前后清库 + 清缓存。
 */
describe('systemSetting.service (integration, real PG)', () => {
  let adminId: string;
  let plainId: string;
  const admin = () => ({ id: adminId, role: UserRole.ADMIN });
  const adminViaKey = (attended = false) => ({
    id: adminId,
    role: UserRole.ADMIN,
    viaApiKey: true,
    unattended: !attended,
  });
  const plain = () => ({ id: plainId, role: UserRole.USER });

  const resetSettings = async () => {
    await prisma.systemLogo.deleteMany();
    await prisma.systemSetting.deleteMany();
    // 审计也要逐用例清:同一操作人跨用例累计会让「只写了一条」之类的断言失真。
    await prisma.auditLog
      .deleteMany({ where: { operatorId: { in: [adminId, plainId] } } })
      .catch(() => {});
    invalidateSystemSettingsCache();
  };

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    plainId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'sys-admin', role: UserRole.ADMIN },
        { id: plainId, name: 'sys-plain', role: UserRole.USER },
      ],
    });
    await resetSettings();
  });

  afterEach(resetSettings);

  afterAll(async () => {
    await resetSettings();
    await prisma.auditLog
      .deleteMany({ where: { operatorId: { in: [adminId, plainId] } } })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [adminId, plainId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('没有设置行 → 全部出厂默认,标志位全空', async () => {
    const { logos, ...scalars } = await getSystemSettings();
    expect(scalars).toEqual(DEFAULT_SYSTEM_SETTINGS);
    expect(logos).toEqual({ standard: null, dark: null, compact: null });
  });

  it('权限红线:非管理员 403;管理员经 Bearer 凭证(含在场交互)同样 403,且不落库', async () => {
    await expect(updateSystemSettings(plain(), { title: 'x' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(updateSystemSettings(adminViaKey(), { title: 'x' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(updateSystemSettings(adminViaKey(true), { title: 'x' })).rejects.toMatchObject({
      status: 403,
    });
    expect(await prisma.systemSetting.count()).toBe(0);
  });

  it('按键合并:两次保存不同卡片互不覆盖;可空文本传空串 = 有意清空;库里只存显式保存过的键', async () => {
    const first = await updateSystemSettings(admin(), { defaultTheme: 'dark' });
    expect(first.defaultTheme).toBe('dark');
    expect(first.title).toBe(DEFAULT_SYSTEM_SETTINGS.title);

    const second = await updateSystemSettings(admin(), {
      title: '科研经费管理平台',
      subtitle: '',
    });
    expect(second).toMatchObject({
      title: '科研经费管理平台',
      subtitle: null,
      defaultTheme: 'dark',
    });

    const row = await prisma.systemSetting.findUniqueOrThrow({
      where: { id: SYSTEM_SETTING_ID },
    });
    expect(row.settings).toEqual({
      defaultTheme: 'dark',
      title: '科研经费管理平台',
      subtitle: null,
    });
  });

  it('审计:有变化才写一条,只记前后有差异的键;同值再存不写', async () => {
    await updateSystemSettings(admin(), { title: '新标题' });
    await updateSystemSettings(admin(), { title: '新标题' });

    const logs = await prisma.auditLog.findMany({
      where: { operatorId: adminId, objectType: SETTINGS_AUDIT_OBJECT_TYPE },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: SETTINGS_AUDIT_ACTION,
      objectId: SYSTEM_SETTING_ID,
      projectId: null,
    });
    expect(logs[0]?.beforeData).toEqual({ title: DEFAULT_SYSTEM_SETTINGS.title });
    expect(logs[0]?.afterData).toEqual({ title: '新标题' });
  });

  it('校验失败 422 且带字段路径;未知键拒绝;均不落库', async () => {
    await expect(updateSystemSettings(admin(), { title: '' })).rejects.toMatchObject({
      status: 422,
      message: 'title: 系统标题不能为空',
    });
    await expect(updateSystemSettings(admin(), { nope: 1 })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      updateSystemSettings(admin(), { dashThresholds: { warn: 90, danger: 80 } }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await prisma.systemSetting.count()).toBe(0);
  });

  it('标志:标准版入库并给出带版本号的地址;字节可原样取回', async () => {
    const png = pngBytes(64, 64);
    const settings = await updateSystemSettings(
      admin(),
      {},
      { standard: { action: 'set', bytes: png } },
    );
    expect(settings.logos.standard).toMatchObject({
      contentType: 'image/png',
      sizeBytes: png.length,
    });
    expect(settings.logos.standard?.url).toMatch(/^\/api\/settings\/logos\/standard\?v=\d+$/);
    expect(settings.logos.dark).toBeNull();

    const stored = await getSystemLogo('standard');
    expect(Buffer.from(stored.data).equals(png)).toBe(true);
  });

  it('标志依附规则:没有标准版时不能单独设置或保留深色版 / 窄栏图标版(422)', async () => {
    const png = pngBytes(8, 8);
    await expect(
      updateSystemSettings(admin(), {}, { dark: { action: 'set', bytes: png } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      updateSystemSettings(admin(), {}, { compact: { action: 'set', bytes: svgBytes() } }),
    ).rejects.toMatchObject({ status: 422 });

    await updateSystemSettings(
      admin(),
      {},
      { standard: { action: 'set', bytes: png }, dark: { action: 'set', bytes: png } },
    );
    await expect(
      updateSystemSettings(admin(), {}, { standard: { action: 'clear' } }),
    ).rejects.toMatchObject({ status: 422 });

    // 连同深色版一并清除则允许,并回落内置标志。
    const settings = await updateSystemSettings(
      admin(),
      {},
      { standard: { action: 'clear' }, dark: { action: 'clear' } },
    );
    expect(settings.logos).toEqual({ standard: null, dark: null, compact: null });
    expect(await prisma.systemLogo.count()).toBe(0);
  });

  it('标志校验:类型不受支持 415、超限 413、SVG 含脚本 400,文案点名标志位;不落库', async () => {
    await expect(
      updateSystemSettings(
        admin(),
        {},
        { standard: { action: 'set', bytes: Buffer.from('text') } },
      ),
    ).rejects.toMatchObject({ status: 415, message: expect.stringContaining('标准版') });
    await expect(
      updateSystemSettings(
        admin(),
        {},
        { standard: { action: 'set', bytes: pngBytes(1, 1, 512 * 1024) } },
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      updateSystemSettings(admin(), {}, { dark: { action: 'set', bytes: svgBytes('<script/>') } }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('深色主题版') });
    expect(await prisma.systemLogo.count()).toBe(0);
  });

  it('标志审计只记类型与大小,不记字节', async () => {
    const png = pngBytes(16, 16);
    await updateSystemSettings(admin(), {}, { standard: { action: 'set', bytes: png } });

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { operatorId: adminId, objectType: SETTINGS_AUDIT_OBJECT_TYPE },
    });
    expect(log.beforeData).toEqual({ logos: { standard: null } });
    expect(log.afterData).toEqual({
      logos: { standard: { contentType: 'image/png', sizeBytes: png.length } },
    });
  });

  it('清除本就不存在的标志位不算变化、不写审计;读取缓存随写入即时失效', async () => {
    expect(await getSystemSettings()).toMatchObject({ title: DEFAULT_SYSTEM_SETTINGS.title });
    await updateSystemSettings(admin(), { title: '立即生效' }, { dark: { action: 'clear' } });
    expect((await getSystemSettings()).title).toBe('立即生效');
    expect(await prisma.auditLog.count({ where: { operatorId: adminId } })).toBe(1);
  });

  it('getSystemLogo:位名非法或未设置 → 404', async () => {
    await expect(getSystemLogo('giant')).rejects.toMatchObject({ status: 404 });
    await expect(getSystemLogo('standard')).rejects.toMatchObject({ status: 404 });
  });

  it('库不可达时 getSystemSettingsSafe 回落出厂默认(页面外壳不随设置表一起挂掉)', async () => {
    // 直接替换方法再赋回,而不是用 spyOn + mockRestore:本仓库的 Vitest 版本对 Prisma 委托
    // 这样还原后会把方法留成 undefined,污染同进程里之后所有读设置的用例。
    const delegate = prisma.systemSetting as unknown as {
      findUnique: (...args: never[]) => Promise<unknown>;
    };
    const originalFindUnique = delegate.findUnique;
    const originalConsoleError = console.error;
    delegate.findUnique = () => Promise.reject(new Error('db down'));
    console.error = () => {};
    try {
      expect(await getSystemSettingsSafe()).toMatchObject(DEFAULT_SYSTEM_SETTINGS);
    } finally {
      console.error = originalConsoleError;
      delegate.findUnique = originalFindUnique;
      invalidateSystemSettingsCache();
    }
    // 复原后可正常读取,且方法确实回到了原实现。
    expect(delegate.findUnique).toBe(originalFindUnique);
    expect((await getSystemSettings()).title).toBe(DEFAULT_SYSTEM_SETTINGS.title);
  });

  it('缓存跨模块实例共享:Next 按路由分别打包,写接口所在实例失效后,页面渲染所在实例立即读到新值', async () => {
    // 第二个模块实例,模拟「页面渲染」那份打包(本文件静态导入的是「写接口」那份)。
    const specifier = '@/server/services/systemSetting.service?instance=page';
    const pageInstance = (await import(
      specifier
    )) as typeof import('@/server/services/systemSetting.service');
    expect((await pageInstance.getSystemSettings()).title).toBe(DEFAULT_SYSTEM_SETTINGS.title);

    await updateSystemSettings(admin(), { title: '跨实例立即可见' });
    expect((await pageInstance.getSystemSettings()).title).toBe('跨实例立即可见');
  });
});
