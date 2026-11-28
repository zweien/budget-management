import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertTestsAllowedIn,
  databaseIdentity,
  readEnvValue,
  testDbGuardReason,
} from '../helpers/testDbGuard';

/**
 * 测试库守卫(纯函数,不连库):生产运行目录里不得对着生产库跑测试。
 * 背景见 testDbGuard.ts 头注。
 */

const PRODUCTION_URL = 'postgresql://budget:secret-pass@127.0.0.1:5434/budget?schema=public';

let dir: string;
/** 在临时检出目录里写一份 .env.production(模拟生产运行目录),返回该目录。 */
function productionCheckout(): string {
  writeFileSync(path.join(dir, '.env.production'), `DATABASE_URL="${PRODUCTION_URL}"\n`);
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('readEnvValue / databaseIdentity', () => {
  it('取值去单/双引号,支持 export 前缀,取不到为 null', () => {
    const text = [
      '# 注释',
      'export A="postgres://a" # 行尾注释',
      "B='x y'",
      'C=no-quote',
      'DATABASE_URL="postgresql://u:p@h:5432/db?schema=public"',
    ].join('\n');
    expect(readEnvValue(text, 'A')).toBe('postgres://a');
    expect(readEnvValue(text, 'B')).toBe('x y');
    expect(readEnvValue(text, 'C')).toBe('no-quote');
    expect(readEnvValue(text, 'DATABASE_URL')).toBe('postgresql://u:p@h:5432/db?schema=public');
    expect(readEnvValue(text, 'MISSING')).toBeNull();
  });

  it('库身份忽略账号/口令/查询参数,回环地址写法归一', () => {
    const base = databaseIdentity(PRODUCTION_URL);
    expect(base).toBe('postgresql://localhost:5434/budget');
    expect(databaseIdentity('postgresql://other:pw@[::1]:5434/budget?schema=public')).toBe(base);
    expect(databaseIdentity('postgresql://u:p@db.internal:5434/budget')).not.toBe(base);
    expect(databaseIdentity('postgresql://u:p@127.0.0.1:5434/other_db')).not.toBe(base);
    expect(databaseIdentity('postgresql://u:p@127.0.0.1:5432/budget')).not.toBe(base);
    expect(databaseIdentity('mysql://u:p@127.0.0.1:5434/budget')).toBeNull();
    expect(databaseIdentity('not a url')).toBeNull();
    expect(databaseIdentity(undefined)).toBeNull();
  });
});

describe('testDbGuardReason', () => {
  it('没有 .env.production(开发检出 / CI / 隔离副本):不限制', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'budget-guard-'));
    expect(testDbGuardReason({ dir, databaseUrl: undefined })).toBeNull();
    expect(testDbGuardReason({ dir, databaseUrl: PRODUCTION_URL })).toBeNull();
  });

  it('生产运行目录 + 未显式设置 DATABASE_URL:拒绝', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'budget-guard-'));
    const reason = testDbGuardReason({ dir: productionCheckout(), databaseUrl: undefined });
    expect(reason).toContain('未显式设置 DATABASE_URL');
  });

  it('生产运行目录 + DATABASE_URL 指向生产库(换账号、换 localhost 写法都算):拒绝', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'budget-guard-'));
    const reason = testDbGuardReason({
      dir: productionCheckout(),
      databaseUrl: 'postgresql://vitest:vitest@localhost:5434/budget',
    });
    expect(reason).toContain('指向本目录 .env.production 的生产库');
    // 拒绝原因不回显连接串原值(含口令)。
    expect(reason).not.toContain('vitest:vitest');
  });

  it('生产运行目录 + DATABASE_URL 指向另一个库:放行', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'budget-guard-'));
    expect(
      testDbGuardReason({
        dir: productionCheckout(),
        databaseUrl: 'postgresql://vitest:vitest@127.0.0.1:5445/vitest',
      }),
    ).toBeNull();
  });

  it('生产运行目录 + 非法连接串:无法核对即拒绝,且不回显原值', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'budget-guard-'));
    const reason = testDbGuardReason({
      dir: productionCheckout(),
      databaseUrl: 'the-password-is-here',
    });
    expect(reason).toContain('不是合法的 postgres 连接串');
    expect(reason).not.toContain('the-password-is-here');
  });

  it('.env.production 读不到:无法核对,拒绝', () => {
    // 以同名目录模拟「存在但读不出内容」(测试进程多为 root,chmod 000 拦不住)。
    dir = mkdtempSync(path.join(os.tmpdir(), 'budget-guard-'));
    mkdirSync(path.join(dir, '.env.production'));
    const reason = testDbGuardReason({
      dir,
      databaseUrl: 'postgresql://vitest:vitest@127.0.0.1:5445/vitest',
    });
    expect(reason).toContain('无法读取');
  });
});

describe('assertTestsAllowedIn', () => {
  it('允许时静默;拒绝时抛出带操作指引的错误', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'budget-guard-'));
    const d = productionCheckout();
    expect(() => assertTestsAllowedIn(d, 'postgresql://u:p@127.0.0.1:5445/vitest')).not.toThrow();
    expect(() => assertTestsAllowedIn(d, PRODUCTION_URL)).toThrow(
      /拒绝运行测试[\s\S]*隔离验证的做法/,
    );
  });
});
