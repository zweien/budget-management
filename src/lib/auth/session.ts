import { User } from '@prisma/client';
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';

/**
 * 获取当前用户。V1 mock:从 x-mock-user-id header 读取。
 * 未来切换真鉴权时,只改此函数的"用户来源",业务代码不变。
 */
export async function getCurrentUser(): Promise<User | null> {
  if (!env.MOCK_AUTH) {
    // 占位:真鉴权接入点(如 NextAuth getSession)。V1 暂不实现。
    throw new Error('MOCK_AUTH=false 时需接入真实鉴权,当前未实现');
  }
  const h = await headers();
  const mockUserId = h.get('x-mock-user-id');
  if (!mockUserId) return null;
  return prisma.user.findUnique({ where: { id: mockUserId } });
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new HTTPError(401, '未登录或用户不存在');
  return user;
}

export class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
