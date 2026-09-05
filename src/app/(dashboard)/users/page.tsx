'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// ============================================================
// 类型
// ============================================================

interface Membership {
  projectId: string;
  projectName: string;
  projectArchived: boolean;
  memberRole: 'OWNER' | 'HANDLER';
}

interface AdminUserRow {
  id: string;
  name: string;
  role: 'ADMIN' | 'USER';
  status: string;
  createdAt: string;
  authBound: boolean;
  serviceAccount: boolean;
  memberships: Membership[];
}

interface ProjectRow {
  id: string;
  name: string;
  archivedAt: string | null;
}

/** 通用确认弹窗状态(单例)。 */
interface ConfirmState {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
}

const ROLE_LABEL: Record<string, string> = {
  OWNER: '负责人',
  HANDLER: '录入人员',
  ADMIN: '管理员',
  USER: '普通用户',
};

// ============================================================
// 页面
// ============================================================

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [meId, setMeId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);

  // 添加项目权限表单。
  const [addProjectId, setAddProjectId] = useState('');
  const [addRole, setAddRole] = useState<'OWNER' | 'HANDLER'>('HANDLER');

  const [busy, setBusy] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const fetchUsers = useCallback(async (): Promise<AdminUserRow[]> => {
    const data = await apiFetch<{ users: AdminUserRow[] }>('/api/admin/users');
    return data.users ?? [];
  }, []);

  // 首次与操作后的统一刷新(setState 仅出现在 Promise 回调,满足 set-state-in-effect)。
  const load = useCallback(async () => {
    try {
      setUsers(await fetchUsers());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载用户列表失败');
      setUsers((prev) => prev ?? []);
    }
  }, [fetchUsers]);

  useEffect(() => {
    let cancelled = false;
    fetchUsers()
      .then((rows) => {
        if (!cancelled) setUsers(rows);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : '加载用户列表失败');
        setUsers((prev) => prev ?? []);
      });
    apiFetch<{ id: string }>('/api/me')
      .then((me) => {
        if (!cancelled) setMeId(me.id);
      })
      .catch(() => {});
    apiFetch<ProjectRow[]>('/api/projects')
      .then((rows) => {
        if (!cancelled) setProjects(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fetchUsers]);

  const selected = useMemo(
    () => users?.find((u) => u.id === selectedId) ?? null,
    [users, selectedId],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users ?? [];
    return (users ?? []).filter((u) => u.name.toLowerCase().includes(q));
  }, [users, search]);

  /** 选中用户的成员关系变化后刷新整表。 */
  const run = useCallback(
    async (fn: () => Promise<unknown>, successMsg?: string) => {
      setBusy(true);
      try {
        await fn();
        await load();
        if (successMsg) toast.success(successMsg);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '操作失败');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /** 账户操作:先确认(弹窗),再 PATCH。 */
  const confirmAccountChange = (
    body: { status?: 'active' | 'disabled'; role?: 'ADMIN' | 'USER' },
    title: string,
    description: React.ReactNode,
  ) => {
    if (!selected) return;
    setConfirmState({
      title,
      description,
      confirmLabel: '确认',
      danger: body.status === 'disabled' || body.role === 'USER',
      onConfirm: async () => {
        await apiFetch(`/api/admin/users/${selected.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      },
    });
  };

  const isSelf = selected !== null && selected.id === meId;
  const pickerProjects = useMemo(() => {
    if (!projects || !selected) return [];
    const memberIds = new Set(selected.memberships.map((m) => m.projectId));
    return projects.filter((p) => !p.archivedAt && !memberIds.has(p.id));
  }, [projects, selected]);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="ADMIN"
        title="用户管理"
        description="集中管理账号(停用/启用、管理员角色)与各用户的项目权限(负责人=可改预算,录入人员=仅录账)。查看权限全局放开,不在此列。"
      />

      {!users ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
          {/* ---- 左:用户列表 ---- */}
          <Card className="self-start">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                用户({filtered.length}/{users.length})
              </CardTitle>
              <Input
                placeholder="按姓名搜索"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8"
              />
            </CardHeader>
            <CardContent className="max-h-[70vh] space-y-1 overflow-y-auto">
              {filtered.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setSelectedId(u.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${
                    u.id === selectedId
                      ? 'border-primary/40 bg-accent'
                      : 'border-transparent hover:bg-accent/60'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{u.name}</span>
                    {u.serviceAccount ? (
                      <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                        服务账号
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {u.role === 'ADMIN' ? <Badge>管理员</Badge> : null}
                    {u.status !== 'active' ? (
                      <Badge variant="error">已停用</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {u.memberships.length} 项目
                      </span>
                    )}
                  </span>
                </button>
              ))}
              {filtered.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">无匹配用户</p>
              ) : null}
            </CardContent>
          </Card>

          {/* ---- 右:详情 ---- */}
          {!selected ? (
            <Card>
              <CardContent className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                从左侧选择一个用户
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {/* 账户信息 + 账户操作 */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {selected.name}
                    {selected.role === 'ADMIN' ? <Badge>管理员</Badge> : null}
                    {selected.status !== 'active' ? <Badge variant="error">已停用</Badge> : null}
                    {selected.serviceAccount ? <Badge variant="outline">服务账号</Badge> : null}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm text-muted-foreground">
                    <span>
                      全局角色:
                      <span className="text-foreground">{ROLE_LABEL[selected.role]}</span>
                    </span>
                    <span>
                      状态:
                      <span className="text-foreground">
                        {selected.status === 'active' ? '活跃' : '已停用'}
                      </span>
                    </span>
                    <span>
                      创建于:
                      <span className="text-foreground">
                        {new Date(selected.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                    </span>
                    <span>
                      SSO:
                      <span className="text-foreground">
                        {selected.authBound ? '已绑定' : '未绑定(本系统外建档)'}
                      </span>
                    </span>
                  </div>
                  {isSelf ? (
                    <Alert>
                      <AlertDescription>不能对自己执行停用或角色变更。</AlertDescription>
                    </Alert>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {selected.status === 'active' ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            confirmAccountChange(
                              { status: 'disabled' },
                              `停用 ${selected.name}?`,
                              <span>
                                停用后其会话与 API Key 立即失效(可重新启用)。
                                {selected.memberships.length > 0 ? (
                                  <>
                                    <br />
                                    该用户在 {selected.memberships.length} 个项目中担任成员 (负责人{' '}
                                    {
                                      selected.memberships.filter((m) => m.memberRole === 'OWNER')
                                        .length
                                    }{' '}
                                    个)——除管理员外,这些项目在其停用期间将无人可改预算/录账。
                                  </>
                                ) : null}
                              </span>,
                            )
                          }
                        >
                          停用账号
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            confirmAccountChange(
                              { status: 'active' },
                              `启用 ${selected.name}?`,
                              '启用后即可正常登录与使用 API Key。',
                            )
                          }
                        >
                          启用账号
                        </Button>
                      )}
                      {selected.role === 'ADMIN' ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            confirmAccountChange(
                              { role: 'USER' },
                              `将 ${selected.name} 降级为普通用户?`,
                              '降级后仅保留全局只读与项目成员权限。',
                            )
                          }
                        >
                          降级为普通用户
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            confirmAccountChange(
                              { role: 'ADMIN' },
                              `将 ${selected.name} 提升为管理员?`,
                              '管理员拥有全部权限(含用户管理、审批、作废)。',
                            )
                          }
                        >
                          提升为管理员
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* 项目权限 */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">项目权限({selected.memberships.length})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {selected.memberships.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      尚未加入任何项目(全局只读仍可查看所有项目)。
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>项目</TableHead>
                          <TableHead className="w-40">角色</TableHead>
                          <TableHead className="w-28 text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selected.memberships.map((m) => (
                          <TableRow key={m.projectId}>
                            <TableCell>
                              <span className="text-sm">{m.projectName}</span>
                              {m.projectArchived ? (
                                <Badge variant="outline" className="ml-2 px-1 py-0 text-[10px]">
                                  已归档
                                </Badge>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <select
                                className="h-8 w-full rounded-md border border-border bg-card px-2 text-sm"
                                value={m.memberRole}
                                disabled={busy}
                                onChange={(e) =>
                                  void run(
                                    () =>
                                      apiFetch(
                                        `/api/projects/${m.projectId}/members/${selected.id}`,
                                        {
                                          method: 'PATCH',
                                          headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify({ memberRole: e.target.value }),
                                        },
                                      ),
                                    '已更新成员角色',
                                  )
                                }
                              >
                                <option value="OWNER">负责人(可改预算)</option>
                                <option value="HANDLER">录入人员(仅录账)</option>
                              </select>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  setConfirmState({
                                    title: `移除 ${selected.name} 在「${m.projectName}」的权限?`,
                                    description: '移除后该用户对此项目仅保留全局只读查看。',
                                    confirmLabel: '移除',
                                    danger: true,
                                    onConfirm: async () => {
                                      await apiFetch(
                                        `/api/projects/${m.projectId}/members/${selected.id}`,
                                        { method: 'DELETE' },
                                      );
                                    },
                                  })
                                }
                              >
                                移除
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}

                  {/* 添加项目权限 */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    <select
                      className="h-8 min-w-56 rounded-md border border-border bg-card px-2 text-sm"
                      value={addProjectId}
                      onChange={(e) => setAddProjectId(e.target.value)}
                      aria-label="选择项目"
                    >
                      <option value="">选择项目…</option>
                      {pickerProjects.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="h-8 rounded-md border border-border bg-card px-2 text-sm"
                      value={addRole}
                      onChange={(e) => setAddRole(e.target.value as 'OWNER' | 'HANDLER')}
                      aria-label="选择成员角色"
                    >
                      <option value="HANDLER">录入人员(仅录账)</option>
                      <option value="OWNER">负责人(可改预算)</option>
                    </select>
                    <Button
                      size="sm"
                      disabled={busy || !addProjectId}
                      onClick={() => {
                        const projectId = addProjectId;
                        void run(
                          () =>
                            apiFetch(`/api/projects/${projectId}/members`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ userId: selected.id, memberRole: addRole }),
                            }),
                          '已添加项目权限',
                        );
                        setAddProjectId('');
                      }}
                    >
                      添加
                    </Button>
                    {pickerProjects.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        无可添加项目(已全部加入或均已归档)
                      </span>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* 单例确认弹窗 */}
      <AlertDialog
        open={confirmState !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmState(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmState?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmState?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirmState?.danger
                  ? 'bg-destructive text-white hover:bg-destructive/90'
                  : undefined
              }
              onClick={() => {
                const c = confirmState;
                setConfirmState(null);
                if (c) void run(c.onConfirm);
              }}
            >
              {confirmState?.confirmLabel ?? '确认'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
