import { describe, it, expect } from 'vitest';
import { can, Action } from '@/lib/auth/permissions';
import { UserRole } from '@prisma/client';

describe('RBAC matrix (§2.2)', () => {
  const owner = { role: UserRole.PROJECT_OWNER } as const;
  const handler = { role: UserRole.AUTHORIZED_HANDLER } as const;
  const admin = { role: UserRole.BUDGET_ADMIN } as const;

  it('项目负责人可编制/调整/记业务,不可审批', () => {
    expect(can(owner, 'budget:editInitial')).toBe(true);
    expect(can(owner, 'budget:adjust')).toBe(true);
    expect(can(owner, 'record:create')).toBe(true);
    expect(can(owner, 'budget:approve')).toBe(false);
  });

  it('授权经办人与项目负责人权限相同', () => {
    for (const a of [
      'budget:editInitial',
      'budget:adjust',
      'record:void',
      'record:import',
    ] as Action[]) {
      expect(can(handler, a)).toBe(can(owner, a));
    }
  });

  it('预算管理员可审批,且可查看全部项目', () => {
    expect(can(admin, 'budget:approve')).toBe(true);
    expect(can(admin, 'project:viewAll')).toBe(true);
    expect(can(owner, 'project:viewAll')).toBe(false);
  });

  it('所有角色都不能执行未定义动作(can 返回 false)', () => {
    expect(can(owner, 'budget:approve' as Action)).toBe(false);
  });
});
