'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { Archive, FolderKanban, Pencil, Plus, RotateCcw, Search, X } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import {
  ProjectFormDialog,
  type DialogCurrentUser,
  type DialogUserOption,
  type ProjectFormTarget,
} from '@/components/projects/project-form-dialog';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  level: string | null;
  projectType: string | null;
  undertakingUnit: string | null;
  startDate: string | null;
  endDate: string | null;
  remark: string | null;
  archivedAt: string | null;
  /** 项目负责人 = 当前 OWNER 成员(§codex P2:成员管理变更后 ownerId 会漂移)。 */
  members: { user: { id: string; name: string } }[];
  /** 行级编辑权(ADMIN 或该项目 OWNER):编辑/归档/恢复按钮的门控。 */
  canEdit: boolean;
}

const formatDate = (d: string | null) => (d ? format(new Date(d), 'yyyy-MM-dd') : '—');

export default function ProjectsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  // 初始即为 true,避免 mount effect 内同步 setState(react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  /** 是否包含已归档项目(项目管理:归档可恢复,开关切换查看)。 */
  const [showArchived, setShowArchived] = useState(false);

  // 新建/编辑共用弹窗;editing = null 表示新建。
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectFormTarget | null>(null);
  // 归档确认目标。
  const [archiveTarget, setArchiveTarget] = useState<ProjectRow | null>(null);
  const [archiving, setArchiving] = useState(false);

  // 当前用户(角色决定新建入口可见性)+ 负责人候选(仅管理员可拉取用户列表)。
  const [me, setMe] = useState<DialogCurrentUser | null>(null);
  const [userOptions, setUserOptions] = useState<DialogUserOption[]>([]);
  // 归档/恢复等动作完成后 bump,触发下方唯一加载点重拉(§codex P2:
  // 手动 reload 不参与 effect 的取消守卫,与开关切换并发时会互相覆盖)。
  const [listVersion, setListVersion] = useState(0);

  useEffect(() => {
    // 当前用户(新建入口门控);管理员顺带预拉负责人候选(仅 ADMIN 可调 /api/users)。
    // 项目列表首拉由下方 showArchived effect 统一负责(§codex P2:两个 effect 各自
    // 发请求会互相覆盖——先发出的默认列表请求可能晚于含归档请求返回)。
    apiFetch<DialogCurrentUser>('/api/me')
      .then((u) => {
        setMe(u);
        if (u.role === 'ADMIN') {
          return apiFetch<DialogUserOption[]>('/api/users').then(setUserOptions);
        }
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  // 项目列表唯一加载点:首拉 + 「显示已归档」切换 + 动作后重拉
  // (loading 初始 true,首拉完成后关闭;setState 全在 await 之后)。
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiFetch<ProjectRow[]>(
          `/api/projects${showArchived ? '?includeArchived=1' : ''}`,
        );
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : '加载项目失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [showArchived, listVersion]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(
      (r) => r.code.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
    );
  }, [rows, keyword]);

  const openCreateDialog = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEditDialog = (r: ProjectRow) => {
    setEditing({
      id: r.id,
      code: r.code,
      name: r.name,
      level: r.level,
      projectType: r.projectType,
      undertakingUnit: r.undertakingUnit,
      startDate: r.startDate,
      endDate: r.endDate,
      remark: r.remark,
    });
    setDialogOpen(true);
  };

  const handleSaved = (
    project: { id: string } & Record<string, unknown>,
    mode: 'create' | 'edit',
  ) => {
    setRows((prev) => {
      if (mode === 'create') {
        // 新建:POST 返回值不含 OWNER 成员关系 → 走服务端重拉,避免负责人列显示错人。
        setListVersion((v) => v + 1);
        return prev;
      }
      // 编辑:就地替换(归档状态不变;编辑不改负责人/成员)。
      return prev.map((r) =>
        r.id === project.id
          ? {
              ...r,
              name: String(project.name ?? r.name),
              level: (project.level as string | null) ?? null,
              projectType: (project.projectType as string | null) ?? null,
              undertakingUnit: (project.undertakingUnit as string | null) ?? null,
              startDate: (project.startDate as string | null) ?? null,
              endDate: (project.endDate as string | null) ?? null,
              remark: (project.remark as string | null) ?? null,
            }
          : r,
      );
    });
  };

  const confirmArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await apiFetch(`/api/projects/${archiveTarget.id}`, { method: 'DELETE' });
      toast.success(`已归档「${archiveTarget.name}」`);
      setArchiveTarget(null);
      setListVersion((v) => v + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setArchiving(false);
    }
  };

  const restoreProject = async (r: ProjectRow) => {
    try {
      await apiFetch(`/api/projects/${r.id}/unarchive`, { method: 'POST' });
      toast.success(`已恢复「${r.name}」`);
      setListVersion((v) => v + 1);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      {/* 页头:caption-mono 眉题 + display-md 负字距标题(DESIGN.md) */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="caption-mono">Projects</p>
          <h1 className="text-display-md">项目管理</h1>
        </div>
        {me?.role === 'ADMIN' ? (
          <Button onClick={openCreateDialog}>
            <Plus />
            新建项目
          </Button>
        ) : null}
      </div>

      {/* 工具行:搜索 + 显示已归档开关 */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative w-full max-w-72">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-mute" />
          <Input
            className="pr-8 pl-8"
            placeholder="按项目编号 / 名称搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword ? (
            <button
              type="button"
              aria-label="清空搜索"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-mute transition-colors hover:text-foreground"
              onClick={() => setKeyword('')}
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Switch id="show-archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor="show-archived" className="text-sm text-muted-foreground">
            显示已归档
          </Label>
        </div>
      </div>

      {/* 数据表:canvas 卡 + hairline + caption-mono 表头(ex-data-table-cell) */}
      {loading ? (
        <div className="rounded-lg border border-border bg-card shadow-l2">
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </div>
      ) : rows.length === 0 ? (
        /* ex-empty-state-card:soft 面 + 宽松内边距 + 引导 */
        <div className="flex flex-col items-center gap-3 rounded-lg bg-muted/60 px-6 py-16 text-center">
          <FolderKanban className="size-8 text-mute" />
          <p className="text-sm text-muted-foreground">暂无项目</p>
          {me?.role === 'ADMIN' ? (
            <Button onClick={openCreateDialog}>
              <Plus />
              新建项目
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-40">项目编号</TableHead>
                <TableHead>项目名称</TableHead>
                <TableHead className="w-28">负责人</TableHead>
                <TableHead className="w-24">级别</TableHead>
                <TableHead className="w-56">起止时间</TableHead>
                <TableHead className="w-64">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    无匹配「{keyword}」的项目
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r.id} className={r.archivedAt ? 'opacity-60' : undefined}>
                    {/* 编号属技术标识,用 mono(DESIGN.md code 字体) */}
                    <TableCell className="font-mono text-[13px]">{r.code}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2 font-medium">
                        {r.name}
                        {r.archivedAt ? <Badge variant="secondary">已归档</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.members?.length ? r.members.map((m) => m.user.name).join('/') : '—'}
                    </TableCell>
                    <TableCell>{r.level ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatDate(r.startDate)} ~ {formatDate(r.endDate)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button
                          variant="link"
                          size="sm"
                          className="px-0"
                          onClick={() => router.push(`/projects/${r.id}`)}
                        >
                          查看详情
                        </Button>
                        {r.canEdit && !r.archivedAt ? (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => openEditDialog(r)}>
                              <Pencil className="size-4" />
                              编辑
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-error-deep hover:bg-error-soft"
                              onClick={() => setArchiveTarget(r)}
                            >
                              <Archive className="size-4" />
                              归档
                            </Button>
                          </>
                        ) : null}
                        {r.canEdit && r.archivedAt ? (
                          <Button variant="ghost" size="sm" onClick={() => void restoreProject(r)}>
                            <RotateCcw className="size-4" />
                            恢复
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="border-t border-border px-4 py-2 text-xs text-mute tabular-nums">
            共 {filtered.length} 个项目{showArchived ? '(含已归档)' : ''}
          </div>
        </div>
      )}

      {/* 新建/编辑共用弹窗:react-hook-form + zod;编辑模式编号只读、负责人不展示 */}
      <ProjectFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        me={me}
        userOptions={userOptions}
        onSaved={handleSaved}
      />

      {/* 归档确认:普通确认弹窗(归档可恢复,数据不删除) */}
      <AlertDialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>归档项目</AlertDialogTitle>
            <AlertDialogDescription>
              确认归档「{archiveTarget?.name}」?归档后项目从列表隐藏,数据完整保留;
              打开「显示已归档」可随时恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiving}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiving}
              onClick={(e) => {
                e.preventDefault();
                void confirmArchive();
              }}
            >
              {archiving ? '归档中…' : '确认归档'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
