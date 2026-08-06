'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { FolderSearch } from 'lucide-react';
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
import { MembersCard } from '@/components/projects/members-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

interface ProjectDetail {
  id: string;
  code: string;
  name: string;
  level: string | null;
  startDate: string | null;
  endDate: string | null;
  ownerId: string;
  remark: string | null;
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

/** §8.7 跨年结转预警条目。 */
interface CarryoverWarning {
  originalRecordId: string;
  subjectCode: string;
  reason: string;
}

/** §8.7 carryOver 返回。 */
interface CarryOverResult {
  carriedCount: number;
  warnings: CarryoverWarning[];
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

  // §8.7 跨年结转 Dialog。
  const [carryoverOpen, setCarryoverOpen] = useState(false);
  const [carryoverSubmitting, setCarryoverSubmitting] = useState(false);
  const [carryoverResult, setCarryoverResult] = useState<CarryOverResult | null>(null);
  const [fromYear, setFromYear] = useState(String(new Date().getFullYear()));
  const [toYear, setToYear] = useState(String(new Date().getFullYear() + 1));
  const [carryoverError, setCarryoverError] = useState<string | null>(null);

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
  }, [projectId]);

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

  /** §8.7 跨年结转。 */
  const handleCarryover = async () => {
    const from = Number(fromYear);
    const to = Number(toYear);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1900 || to > 9999) {
      setCarryoverError('请输入有效年度(1900-9999)');
      return;
    }
    if (to <= from) {
      setCarryoverError('目标年度必须大于源年度');
      return;
    }
    setCarryoverError(null);
    setCarryoverSubmitting(true);
    try {
      const result = await apiFetch<CarryOverResult>(`/api/projects/${projectId}/carryover`, {
        method: 'POST',
        body: JSON.stringify({ fromYear: from, toYear: to }),
      });
      setCarryoverResult(result);
      toast.success(`已结转 ${result.carriedCount} 条记录`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCarryoverSubmitting(false);
    }
  };

  /** 关闭结转 Dialog,清空结果与错误。 */
  const closeCarryover = () => {
    setCarryoverOpen(false);
    setCarryoverResult(null);
    setCarryoverError(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-[-0.3px]">项目信息</h2>
        {project.canEdit ? (
          <Button
            variant="outline"
            onClick={() => {
              setCarryoverResult(null);
              setCarryoverError(null);
              setCarryoverOpen(true);
            }}
          >
            跨年结转
          </Button>
        ) : null}
      </div>

      {/* 描述网格:hairline 网格线,替代 antd Descriptions bordered */}
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-l2 sm:grid-cols-2">
        <DescCell label="项目编号">
          <span className="font-mono text-[13px]">{project.code}</span>
        </DescCell>
        <DescCell label="项目名称">{project.name}</DescCell>
        <DescCell label="级别">{project.level ?? '—'}</DescCell>
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
        <DescCell label="备注" span2>
          {project.remark ?? '—'}
        </DescCell>
      </dl>

      {/* 成员管理:仅管理员可见(服务端 member:manage 二次拦截)。 */}
      {me?.role === 'ADMIN' ? <MembersCard projectId={project.id} /> : null}

      {isEffective ? (
        <Alert variant="success">
          <AlertTitle>初始预算已生效</AlertTitle>
          <AlertDescription>可前往「执行台账」查看各科目当前预算与占用情况。</AlertDescription>
        </Alert>
      ) : null}

      {/* §8.7 跨年结转 */}
      <Dialog open={carryoverOpen} onOpenChange={(open) => (open ? null : closeCarryover())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>跨年结转</DialogTitle>
            <DialogDescription>
              将源年度中尚未支出(非 PAID)的业务记录结转到目标年度,生成可追溯记录。
            </DialogDescription>
          </DialogHeader>

          {carryoverResult ? (
            <div className="space-y-3">
              <Alert variant="success">
                <AlertTitle>已结转 {carryoverResult.carriedCount} 条业务记录</AlertTitle>
              </Alert>
              {carryoverResult.warnings.length > 0 && (
                <Alert variant="warning">
                  <AlertTitle>以下记录需人工确认(§8.7)</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {carryoverResult.warnings.map((w) => (
                        <li key={w.originalRecordId}>
                          {w.subjectCode}:{w.reason}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button onClick={closeCarryover}>关闭</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="from-year">源年度</Label>
                  <Input
                    id="from-year"
                    type="number"
                    min={1900}
                    max={9999}
                    value={fromYear}
                    onChange={(e) => setFromYear(e.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="to-year">目标年度</Label>
                  <Input
                    id="to-year"
                    type="number"
                    min={1900}
                    max={9999}
                    value={toYear}
                    onChange={(e) => setToYear(e.target.value)}
                  />
                </div>
              </div>
              {carryoverError ? <p className="text-xs text-destructive">{carryoverError}</p> : null}
              <DialogFooter>
                <Button variant="outline" onClick={closeCarryover} disabled={carryoverSubmitting}>
                  取消
                </Button>
                <Button onClick={handleCarryover} disabled={carryoverSubmitting}>
                  {carryoverSubmitting ? '结转中…' : '执行结转'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
