import { describe, it, expect } from 'vitest';

import { signSession, verifySession } from '@/lib/auth/session';

// AUTH_SECRET 由 vitest.config.ts 的 test.env 注入。

describe('会话 JWT(signSession/verifySession)', () => {
  it('签发-校验往返:sub 与 id_token 还原', async () => {
    const token = await signSession('user-123', 'id-token-abc');
    const session = await verifySession(token);
    expect(session).toEqual({ userId: 'user-123', idToken: 'id-token-abc' });
  });

  it('无 id_token 时省略该字段', async () => {
    const session = await verifySession(await signSession('user-456'));
    expect(session).toEqual({ userId: 'user-456', idToken: undefined });
  });

  it('篡改的 token 校验失败(返回 null)', async () => {
    const token = await signSession('user-789');
    const tampered = `${token.slice(0, -4)}AAAA`;
    await expect(verifySession(tampered)).resolves.toBeNull();
  });

  it('明显非法的 token 返回 null 而非抛错', async () => {
    await expect(verifySession('not-a-jwt')).resolves.toBeNull();
  });
});
