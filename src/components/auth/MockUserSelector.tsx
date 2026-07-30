'use client';

import { useEffect, useState } from 'react';
import { Select, Tag, Typography, message } from 'antd';
import { UserOutlined } from '@ant-design/icons';

import { apiFetch, getMockUserId, setMockUserId } from '@/lib/api/client';

const { Text } = Typography;

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

const ROLE_COLOR: Record<string, string> = {
  PROJECT_OWNER: 'blue',
  AUTHORIZED_HANDLER: 'green',
  BUDGET_ADMIN: 'purple',
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
    message.success(`已切换为:${u?.name ?? value}`);
    // 切换身份后刷新用户列表(新身份可能能看到更多用户)。
    void refreshUsers();
  };

  if (!bootstrapped) {
    return <Text type="secondary">加载用户列表…</Text>;
  }
  if (!current || users.length === 0) {
    return <Text type="danger">未找到可用用户(请检查数据库种子)</Text>;
  }

  const me = users.find((u) => u.id === current);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <UserOutlined />
      <Select
        size="small"
        loading={loading}
        value={current}
        onChange={handleChange}
        style={{ minWidth: 200 }}
        showSearch
        optionFilterProp="label"
        options={users.map((u) => ({
          value: u.id,
          label: `${u.name} (${ROLE_LABEL[u.role] ?? u.role})`,
        }))}
        placeholder="选择模拟用户"
      />
      {me ? (
        <Tag color={ROLE_COLOR[me.role] ?? 'default'}>{ROLE_LABEL[me.role] ?? me.role}</Tag>
      ) : null}
    </span>
  );
}
