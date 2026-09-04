'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { FolderSearch, Pencil } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/layout/empty-state';
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

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
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
