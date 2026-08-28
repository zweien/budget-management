'use client';

import * as React from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

interface MemberRow {
  userId: string;
  name: string;
  memberRole: 'OWNER' | 'HANDLER';
}

interface UserOption {
  id: string;
  name: string;
  role: string;
}

const MEMBER_ROLE_LABEL: Record<string, string> = {
  OWNER: '负责人(全部权限)',
  HANDLER: '成员(可录入)',
};

/**
 * 项目成员管理卡片(仅管理员渲染;服务端 member:manage 二次拦截)。
 * 项目编辑权由此驱动:OWNER=可编辑,HANDLER=只读。
 */
export function MembersCard({
  projectId,
  onMembersChanged,
}: {
  projectId: string;
  /** 成员/OWNER 变更成功后通知父级(如详情页刷新负责人摘要)。 */
  onMembersChanged?: () => void;
}) {
  const [members, setMembers] = React.useState<MemberRow[] | null>(null);
  const [allUsers, setAllUsers] = React.useState<UserOption[]>([]);
  const [pickUser, setPickUser] = React.useState<string>('');
  const [pickRole, setPickRole] = React.useState<'OWNER' | 'HANDLER'>('OWNER');
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const [m, u] = await Promise.all([
        apiFetch<MemberRow[]>(`/api/projects/${projectId}/members`),
        apiFetch<UserOption[]>('/api/users'),
      ]);
      setMembers(m);
      setAllUsers(u);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [projectId]);

  React.useEffect(() => {
    // load 内的 setState 均在 await 之后(异步),非同步级联;禁用误报(同 projects/page 约定)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await load();
      onMembersChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const candidates = allUsers.filter((u) => !members?.some((m) => m.userId === u.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">成员管理</CardTitle>
        <p className="text-xs text-muted-foreground">
          负责人(OWNER)拥有该项目全部编辑权限;成员(HANDLER)可录入/维护业务记录。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {members === null ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {members.length === 0 ? (
              <li className="px-3 py-4 text-center text-sm text-muted-foreground">暂无成员</li>
            ) : (
              members.map((m) => (
                <li key={m.userId} className="flex items-center gap-2 px-3 py-2">
                  <span className="text-sm">{m.name}</span>
                  <Badge variant={m.memberRole === 'OWNER' ? 'success' : 'secondary'}>
                    {MEMBER_ROLE_LABEL[m.memberRole]}
                  </Badge>
                  <div className="ml-auto flex items-center gap-1">
                    <Select
                      value={m.memberRole}
                      onValueChange={(v) =>
                        void run(
                          () =>
                            apiFetch(`/api/projects/${projectId}/members/${m.userId}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ memberRole: v }),
                            }),
                          `已调整 ${m.name} 的角色`,
                        )
                      }
                      disabled={busy}
                    >
                      <SelectTrigger size="sm" className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="OWNER">负责人</SelectItem>
                        <SelectItem value="HANDLER">成员</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`移除 ${m.name}`}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            apiFetch(`/api/projects/${projectId}/members/${m.userId}`, {
                              method: 'DELETE',
                            }),
                          `已移除 ${m.name}`,
                        )
                      }
                    >
                      <Trash2 className="text-error-deep" />
                    </Button>
                  </div>
                </li>
              ))
            )}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Combobox
            options={candidates.map((u) => ({ value: u.id, label: u.name }))}
            value={pickUser}
            onChange={setPickUser}
            placeholder="选择用户"
            searchPlaceholder="搜索用户名…"
            emptyText="无匹配用户"
            disabled={busy}
            className="w-44"
          />
          <Select
            value={pickRole}
            onValueChange={(v) => setPickRole(v as 'OWNER' | 'HANDLER')}
            disabled={busy}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OWNER">负责人</SelectItem>
              <SelectItem value="HANDLER">成员</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !pickUser}
            onClick={() =>
              void run(
                () =>
                  apiFetch(`/api/projects/${projectId}/members`, {
                    method: 'POST',
                    body: JSON.stringify({ userId: pickUser, memberRole: pickRole }),
                  }),
                '已添加成员',
              ).then(() => setPickUser(''))
            }
          >
            <UserPlus />
            添加成员
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
