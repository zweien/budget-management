'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { AlertTriangle, FolderSearch, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/layout/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MembersCard } from '@/components/projects/members-card';
import {
  ProjectFormDialog,
  type ProjectFormTarget,
} from '@/components/projects/project-form-dialog';
import { Skeleton } from '@/components/ui/skeleton';

interface ProjectDetail {
  id: string;
  code: string;
  name: string;
  level: string | null;
  projectType: string | null;
  /** 预算类型(§包干制):GENERAL / LUMP_SUM。 */
  budgetMode: string | null;
  undertakingUnit: string | null;
  startDate: string | null;
  endDate: string | null;
  ownerId: string;
  /** 项目负责人 = 当前 OWNER 成员(与列表页同口径)。 */
  members: { user: { id: string; name: string } }[];
  remark: string | null;
  archivedAt: string | null;
  createdAt: string;
  /** 服务端随详情下发:当前用户是否可编辑该项目(ADMIN 或 OWNER 成员)。 */
  canEdit: boolean;
}

/** /api/me 当前用户。 */
interface CurrentUser {
  id: string;
  name: string;
  role: 'ADMIN' | 'USER';
}

/** 初始预算编制单状态。 */
interface InitialBudgetState {
  id?: string;
  status?: string;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿中',
  PENDING: '待审批',
  APPROVED: '已生效',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
};

/** Badge 语义色遵循 DESIGN.md:蓝=success/link、琥珀=warning、红=error。 */
const STATUS_BADGE: Record<string, 'secondary' | 'warning' | 'success' | 'error' | 'outline'> = {
  DRAFT: 'secondary',
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  WITHDRAWN: 'outline',
};

const formatDate = (d: string | null) => (d ? format(new Date(d), 'yyyy-MM-dd') : '—');

/** 描述网格单元:hairline 网格(gap-px 透出底边框色)。 */
function DescCell({
  label,
  children,
  span2,
}: {
  label: string;
  children: React.ReactNode;
  span2?: boolean;
}) {
  return (
    <div className={span2 ? 'bg-card p-3 sm:col-span-2' : 'bg-card p-3'}>
      <dt className="text-xs text-mute">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

/** 彻底删除预览(GET /api/projects/:id/purge)。 */
interface PurgePreview {
  projectId: string;
  code: string;
  name: string;
  archivedAt: string;
  recordCount: number;
  voidRecordCount: number;
  attachmentCount: number;
  receiptCount: number;
  importBatchCount: number;
  memberCount: number;
  paidAmount: string;
  totalOccupied: string;
}

/**
 * 危险区卡片(仅管理员 + 已归档可见):彻底删除项目。
 * 不可逆且从全局统计抹掉金额——弹窗列明数据量,输入项目编号确认(§彻底删除裁决)。
 */
function DangerZoneCard({
  projectId,
  code,
  onPurged,
}: {
  projectId: string;
  code: string;
  onPurged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [purging, setPurging] = useState(false);

  const canConfirm = confirmText.trim() === code && !!preview;

  const openDialog = () => {
    setOpen(true);
    setConfirmText('');
    setPreview(null);
    setLoadingPreview(true);
    void apiFetch<PurgePreview>(`/api/projects/${projectId}/purge`)
      .then(setPreview)
      .catch((e: unknown) => {
        if (e instanceof Error) toast.error(e.message);
        setOpen(false);
      })
      .finally(() => setLoadingPreview(false));
  };

  const handlePurge = async () => {
    if (!canConfirm || purging) return;
    setPurging(true);
    try {
      // confirmCode 服务端强校验(codex P1):输入编号确认不能只存在于前端状态。
      await apiFetch(`/api/projects/${projectId}/purge`, {
        method: 'POST',
        body: JSON.stringify({ confirmCode: confirmText.trim() }),
      });
      toast.success('项目已彻底删除');
      setOpen(false);
      onPurged();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setPurging(false);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-error/40 bg-error-soft/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-error-deep">
              <AlertTriangle className="size-4" />
              危险区
            </p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              项目已归档。彻底删除将永久清除该项目及其全部业务数据（不可恢复），
              相关记录将从检索与统计中消失；操作审计保留留痕。
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={openDialog}>
            <Trash2 />
            彻底删除
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>彻底删除项目</DialogTitle>
            <DialogDescription>
              此操作不可逆。项目「{code}」及其全部业务数据将被物理删除，无法恢复。
            </DialogDescription>
          </DialogHeader>

          {loadingPreview ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : preview ? (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-sm font-medium">{preview.name}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <div>
                  业务记录：
                  {preview.recordCount} 条
                  {preview.voidRecordCount > 0 ? `（含作废 ${preview.voidRecordCount} 条）` : ''}
                </div>
                <div>附件：{preview.attachmentCount} 个</div>
                <div>到账记录：{preview.receiptCount} 笔</div>
                <div>导入批次：{preview.importBatchCount} 个</div>
                <div className="tabular-nums">已支出：{preview.paidAmount} 元</div>
                <div className="tabular-nums">总占用：{preview.totalOccupied} 元</div>
              </dl>
              <p className="caption-mono mt-2 tabular-nums">
                归档于 {format(new Date(preview.archivedAt), 'yyyy-MM-dd HH:mm')}
              </p>
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="purge-confirm">
              请输入项目编号 <span className="font-mono text-[13px]">{code}</span> 以确认
            </Label>
            <Input
              id="purge-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={code}
              autoComplete="off"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={purging}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handlePurge()}
              disabled={!canConfirm || purging}
            >
              <Trash2 />
              {purging ? '删除中…' : '我已知晓后果，彻底删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [budget, setBudget] = useState<InitialBudgetState | null>(null);
  const [me, setMe] = useState<CurrentUser | null>(null);
  // 初始即为 true,避免 mount effect 内同步 setState(react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // 编辑项目信息弹窗(§项目管理);保存后 bump 版本触发详情重拉。
  const [editOpen, setEditOpen] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [p, b, m] = await Promise.allSettled([
          apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
          apiFetch<InitialBudgetState | null>(`/api/projects/${projectId}/initial-budget`),
          apiFetch<CurrentUser>('/api/me'),
        ]);
        if (cancelled) return;
        if (p.status === 'fulfilled') {
          setProject(p.value);
        } else {
          // 403/404 等:详情拿不到就显示错误态。
          setNotFound(true);
          if (p.reason instanceof Error) toast.error(p.reason.message);
        }
        if (b.status === 'fulfilled' && b.value) {
          setBudget(b.value);
        }
        if (m.status === 'fulfilled') {
          setMe(m.value);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, detailVersion]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (notFound || !project) {
    return (
      <EmptyState
        icon={<FolderSearch />}
        title="无法访问该项目"
        description="项目可能不存在或您没有访问权限。"
        action={
          <Link href="/projects">
            <Button>返回项目列表</Button>
          </Link>
        }
      />
    );
  }

  const isEffective = budget?.status === 'APPROVED';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-[-0.3px]">项目信息</h2>
        {project.archivedAt ? <Badge variant="secondary">已归档</Badge> : null}
        {project.canEdit && !project.archivedAt ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              编辑项目信息
            </Button>
          </div>
        ) : null}
      </div>

      {/* 描述网格:hairline 网格线,替代 antd Descriptions bordered */}
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-l2 sm:grid-cols-2">
        <DescCell label="项目编号">
          <span className="font-mono text-[13px]">{project.code}</span>
        </DescCell>
        <DescCell label="项目名称">{project.name}</DescCell>
        <DescCell label="项目负责人">
          {project.members?.length ? project.members.map((m) => m.user.name).join('/') : '—'}
        </DescCell>
        <DescCell label="级别">{project.level ?? '—'}</DescCell>
        <DescCell label="项目类型">{project.projectType ?? '—'}</DescCell>
        <DescCell label="起止时间">
          <span className="tabular-nums">
            {formatDate(project.startDate)} ~ {formatDate(project.endDate)}
          </span>
        </DescCell>
        <DescCell label="创建时间">
          <span className="tabular-nums">
            {format(new Date(project.createdAt), 'yyyy-MM-dd HH:mm')}
          </span>
        </DescCell>
        <DescCell label="预算状态">
          {budget?.status ? (
            <Badge variant={STATUS_BADGE[budget.status] ?? 'secondary'}>
              {STATUS_LABEL[budget.status] ?? budget.status}
            </Badge>
          ) : (
            <span className="text-muted-foreground">未编制</span>
          )}
        </DescCell>
        <DescCell label="预算类型">
          {project.budgetMode === 'LUMP_SUM' ? (
            <Badge variant="warning">包干制</Badge>
          ) : (
            <Badge variant="secondary">一般</Badge>
          )}
        </DescCell>
        <DescCell label="备注">{project.remark ?? '—'}</DescCell>
      </dl>

      {/* 成员管理:仅管理员可见(服务端 member:manage 二次拦截)。 */}
      {me?.role === 'ADMIN' ? (
        <MembersCard
          projectId={project.id}
          onMembersChanged={() => setDetailVersion((v) => v + 1)}
        />
      ) : null}

      {/* 危险区:仅管理员 + 已归档(服务端 project:delete + 会话红线二次拦截)。 */}
      {me?.role === 'ADMIN' && project.archivedAt ? (
        <DangerZoneCard
          projectId={project.id}
          code={project.code}
          onPurged={() => router.push('/projects')}
        />
      ) : null}

      {isEffective ? (
        <Alert variant="success">
          <AlertTitle>初始预算已生效</AlertTitle>
          <AlertDescription>可前往「执行台账」查看各科目当前预算与占用情况。</AlertDescription>
        </Alert>
      ) : null}

      {/* 编辑项目信息弹窗(§项目管理):与列表页共用同一组件 */}
      {project ? (
        <ProjectFormDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          editing={project as ProjectFormTarget}
          me={me}
          userOptions={[]}
          onSaved={() => setDetailVersion((v) => v + 1)}
        />
      ) : null}
    </div>
  );
}
