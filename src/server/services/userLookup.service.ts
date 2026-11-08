/**
 * 用户按键查找(严格版):CLI 与服务共用的查找机制。
 * 键 = 用户姓名 / 本地 id / SSO sub(UUID);User.name 无唯一约束(SSO JIT 显示名可
 * 重名),故一律 findMany 按创建序返回,由调用方对 0/多命中自行给出场景化报错
 * (参照 make-admin 的防歧义约定)。
 */
import type { PrismaClient, User } from '@prisma/client';

/** UUID 形态检测:id 是 UUID 列,非 UUID 输入不能塞进 OR 否则 Prisma 校验报错。 */
export const USER_KEY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID 键同时匹配 id / authSubject(SSO sub,最稳定的机器键)/ name;非 UUID 只按 name。 */
export async function findUsersByKey(
  client: Pick<PrismaClient, 'user'>,
  key: string,
): Promise<User[]> {
  const isUuid = USER_KEY_UUID_RE.test(key);
  return client.user.findMany({
    where: isUuid ? { OR: [{ id: key }, { authSubject: key }, { name: key }] } : { name: key },
    orderBy: { createdAt: 'asc' },
  });
}
