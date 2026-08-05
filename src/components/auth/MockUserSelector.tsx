'use client';

import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch, getMockUserId, setMockUserId } from '@/lib/api/client';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

interface UserOption {
  id: string;
  name: string;
  role: string;
}

const ROLE_LABEL: Record<string, string> = {
  PROJECT_OWNER: '项目负责人',
  AUTHORIZED_HANDLER: '经办人',
  BUDGET_ADMIN: '预算管理员',
};

/** Badge 语义色遵循 DESIGN.md:蓝=link/success、琥珀=warning、ink=primary。 */
const ROLE_BADGE: Record<string, 'success' | 'warning' | 'default'> = {
  PROJECT_OWNER: 'success',
  AUTHORIZED_HANDLER: 'warning',
  BUDGET_ADMIN: 'default',
};

/**
 * 顶部"模拟用户"选择器(V1 mock 鉴权)。
 * 当前身份写入 localStorage,apiFetch 读取后以 `x-mock-user-id` header 注入。
 *
 * Bootstrap 流程:首次进入无身份 → 调 /api/users(无 header 时返回 admin 种子列表)
 * → 默认选中第一个 admin → 后续切换以 admin 身份拉取完整用户列表。
 */
export function MockUserSelector() {
  // 用惰性初始化读取 localStorage,避免 effect 内同步 setState。
  const [current, setCurrent] = useState<string | null>(() => getMockUserId());
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [bootstrapped, setBootstrapped] = useState(false);

  // 拉取可切换用户列表(已登录时为完整列表,未登录时为 admin 种子)。
  const refreshUsers = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const list = await apiFetch<UserOption[]>('/api/users');
      setUsers(list);
      const stored = getMockUserId();
      if (list.length && (!stored || !list.some((u) => u.id === stored))) {
        // 尚未选择 / 当前身份不在列表 → 默认选第一个 admin。
        const admin = list.find((u) => u.role === 'BUDGET_ADMIN') ?? list[0];
        setMockUserId(admin.id);
        setCurrent(admin.id);
      }
    } catch {
      // 当前身份非 admin → 看不到完整列表,保持现有身份。
    } finally {
      setLoading(false);
      setBootstrapped(true);
    }
  };

  useEffect(() => {
    // loading 已初始化为 true,首次调用不同步 setState。
    // 数据拉取是 effect 的合法用途,禁用 set-state-in-effect(本场景无级联渲染风险)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshUsers(false);
  }, []);

  // 跨组件 / 跨标签页身份同步。
  useEffect(() => {
    const sync = () => setCurrent(getMockUserId());
    window.addEventListener('mock-user-change', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('mock-user-change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const handleChange = (value: string) => {
    setMockUserId(value);
    setCurrent(value);
    const u = users.find((x) => x.id === value);
    toast.success(`已切换为:${u?.name ?? value}`);
    // 切换身份后刷新用户列表(新身份可能能看到更多用户)。
    void refreshUsers();
  };

  if (!bootstrapped) {
    return <Skeleton className="h-8 w-48" />;
  }
  if (!current || users.length === 0) {
    return <span className="text-sm text-error-deep">未找到可用用户(请检查数据库种子)</span>;
  }

  const me = users.find((u) => u.id === current);

  return (
    <span className="inline-flex items-center gap-2">
      <UserRound className="size-4 text-mute" />
      <Select value={current} onValueChange={handleChange} disabled={loading}>
        <SelectTrigger className="w-36 sm:w-52" aria-label="选择模拟用户">
          <SelectValue placeholder="选择模拟用户" />
        </SelectTrigger>
        <SelectContent>
          {users.map((u) => (
            <SelectItem key={u.id} value={u.id}>
              {u.name}({ROLE_LABEL[u.role] ?? u.role})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {me ? (
        <Badge variant={ROLE_BADGE[me.role] ?? 'secondary'} className="hidden sm:inline-flex">
          {ROLE_LABEL[me.role] ?? me.role}
        </Badge>
      ) : null}
    </span>
  );
}
