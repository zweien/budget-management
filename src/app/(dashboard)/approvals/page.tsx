'use client';

import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { EmptyState } from '@/components/layout/empty-state';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface ProjectRef {
  id: string;
  code: string;
  name: string;
}
interface UserRef {
  id: string;
  name: string;
}

interface InitialBudgetPending {
  id: string;
  projectId: string;
  status: string;
  applicantId: string;
  createdAt: string;
  updatedAt: string;
  project: ProjectRef;
  applicant: UserRef;
}

interface AdjustmentPending {
  id: string;
  projectId: string;
  year: number;
  status: string;
  reason: string | null;
  applicantId: string;
  createdAt: string;
  updatedAt: string;
  project: ProjectRef;
  applicant: UserRef;
  lineCount?: number;
}

interface SubjectChangePending {
  id: string;
  projectId: string;
  status: string;
  applicantId: string;
  createdAt: string;
  updatedAt: string;
  project: ProjectRef;
  applicant: UserRef;
}

interface PendingResponse {
  initialBudgets: InitialBudgetPending[];
  adjustments: AdjustmentPending[];
  subjectChanges: SubjectChangePending[];
}

type ApproveTarget =
  | { kind: 'initialBudget'; row: InitialBudgetPending }
  | { kind: 'adjustment'; row: AdjustmentPending }
  | { kind: 'subjectChange'; row: SubjectChangePending };

const formatDateTime = (s: string | null): string => {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm');
};

export default function ApprovalsPage() {
  const [data, setData] = useState<PendingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // 审批/驳回 Dialog。
  const [target, setTarget] = useState<ApproveTarget | null>(null);
  const [mode, setMode] = useState<'approve' | 'reject'>('approve');
  const [opinion, setOpinion] = useState('');
  const [opinionError, setOpinionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadPending = useCallback(async () => {
    setLoading(true);
    setFatal(null);
    try {
      const result = await apiFetch<PendingResponse>('/api/approvals/pending');
      setData(result);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 403) {
        setForbidden(true);
      } else {
        setFatal(err.message || '加载待办失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 首次加载 loading 已为 true,无需同步 setState。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPending();
  }, [loadPending]);

  const openAction = (next: ApproveTarget, nextMode: 'approve' | 'reject') => {
    setTarget(next);
    setMode(nextMode);
    setOpinion('');
    setOpinionError(null);
  };

  const closeAction = () => {
    setTarget(null);
    setOpinion('');
    setOpinionError(null);
  };

  const submitAction = async () => {
    if (!target) return;
    const trimmed = opinion.trim();
    if (mode === 'reject' && !trimmed) {
      setOpinionError('请填写驳回意见');
      return;
    }

    setSubmitting(true);
    try {
      const { kind, row } = target;
      const projectId = row.projectId;
      const paths: Record<ApproveTarget['kind'], string> = {
        initialBudget: `/api/projects/${projectId}/initial-budget/${row.id}/${mode}`,
        adjustment: `/api/projects/${projectId}/adjustments/${row.id}/${mode}`,
        subjectChange: `/api/projects/${projectId}/subject-changes/${row.id}/${mode}`,
      };
      const path = paths[kind];
      if (!path) throw new Error('未知待办类型');
      await apiFetch(path, {
        method: 'POST',
        body: JSON.stringify({ opinion: trimmed }),
      });
      toast.success(mode === 'approve' ? '已审批通过' : '已驳回');
      closeAction();
      await loadPending();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (forbidden) {
    return (
      <EmptyState
        icon={<ShieldAlert />}
        title="无权访问审批中心"
        description="审批中心仅对预算管理员开放。如需审批权限,请联系管理员调整角色。"
      />
    );
  }

  if (fatal) {
    return (
      <div className="space-y-4">
        <Alert variant="error">
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => void loadPending()}>
          重试
        </Button>
      </div>
    );
  }

  const initialCount = data?.initialBudgets.length ?? 0;
  const adjustmentCount = data?.adjustments.length ?? 0;
  const subjectChangeCount = data?.subjectChanges.length ?? 0;

  const targetRow = target?.row;

  const actionCell = (t: ApproveTarget) => (
    <div className="flex gap-2">
      <Button size="sm" onClick={() => openAction(t, 'approve')}>
        审批
      </Button>
      <Button size="sm" variant="outline" onClick={() => openAction(t, 'reject')}>
        驳回
      </Button>
    </div>
  );

  const projectCell = (p: ProjectRef) => (
    <span>
      <span className="font-mono text-[13px]">{p.code}</span>
      <span className="mx-1.5 text-mute">·</span>
      {p.name}
    </span>
  );

  const countBadge = (n: number) =>
    n > 0 ? <Badge variant="success">{n}</Badge> : <Badge variant="secondary">{n}</Badge>;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Approvals"
        title="审批中心"
        description="汇总待审批的初始预算编制、预算调整与科目变更。"
      />

      <Tabs defaultValue="initialBudget">
        <TabsList>
          <TabsTrigger value="initialBudget">初始预算编制 {countBadge(initialCount)}</TabsTrigger>
          <TabsTrigger value="adjustment">预算调整 {countBadge(adjustmentCount)}</TabsTrigger>
          <TabsTrigger value="subjectChange">科目变更 {countBadge(subjectChangeCount)}</TabsTrigger>
        </TabsList>

        <TabsContent value="initialBudget">
          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>项目</TableHead>
                  <TableHead className="w-32">申请人</TableHead>
                  <TableHead className="w-44">提交时间</TableHead>
                  <TableHead className="w-44">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ) : (data?.initialBudgets.length ?? 0) === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                      暂无待审批编制单
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.initialBudgets.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{projectCell(r.project)}</TableCell>
                      <TableCell>{r.applicant.name}</TableCell>
                      <TableCell className="tabular-nums">{formatDateTime(r.updatedAt)}</TableCell>
                      <TableCell>{actionCell({ kind: 'initialBudget', row: r })}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="adjustment">
          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>项目</TableHead>
                  <TableHead className="w-20">年度</TableHead>
                  <TableHead className="w-20">明细数</TableHead>
                  <TableHead>原因</TableHead>
                  <TableHead className="w-32">申请人</TableHead>
                  <TableHead className="w-44">提交时间</TableHead>
                  <TableHead className="w-44">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ) : (data?.adjustments.length ?? 0) === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                      暂无待审批调整单
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.adjustments.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{projectCell(r.project)}</TableCell>
                      <TableCell className="tabular-nums">{r.year}</TableCell>
                      <TableCell className="tabular-nums">{r.lineCount ?? '—'}</TableCell>
                      <TableCell className="max-w-48 truncate" title={r.reason ?? undefined}>
                        {r.reason ?? '—'}
                      </TableCell>
                      <TableCell>{r.applicant.name}</TableCell>
                      <TableCell className="tabular-nums">{formatDateTime(r.updatedAt)}</TableCell>
                      <TableCell>{actionCell({ kind: 'adjustment', row: r })}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="subjectChange">
          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>项目</TableHead>
                  <TableHead className="w-32">申请人</TableHead>
                  <TableHead className="w-44">提交时间</TableHead>
                  <TableHead className="w-44">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ) : (data?.subjectChanges.length ?? 0) === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                      暂无待审批科目变更单
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.subjectChanges.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{projectCell(r.project)}</TableCell>
                      <TableCell>{r.applicant.name}</TableCell>
                      <TableCell className="tabular-nums">{formatDateTime(r.updatedAt)}</TableCell>
                      <TableCell>{actionCell({ kind: 'subjectChange', row: r })}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      {/* 审批/驳回 Dialog:意见为原生受控 textarea(无中文输入法问题) */}
      <Dialog open={!!target} onOpenChange={(open) => (open ? null : closeAction())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === 'approve' ? '审批通过' : '驳回'}</DialogTitle>
          </DialogHeader>
          {targetRow ? (
            <div className="space-y-3 text-sm">
              <p>
                <span className="text-muted-foreground">项目:</span>
                {projectCell(targetRow.project)}
              </p>
              <p>
                <span className="text-muted-foreground">申请人:</span>
                {targetRow.applicant.name}
              </p>
              <div className="grid gap-1.5">
                <Label htmlFor="opinion">审批意见</Label>
                <Textarea
                  id="opinion"
                  rows={3}
                  placeholder={mode === 'approve' ? '可选填写意见' : '请填写驳回原因'}
                  value={opinion}
                  onChange={(e) => {
                    setOpinion(e.target.value);
                    if (opinionError) setOpinionError(null);
                  }}
                  aria-invalid={!!opinionError}
                />
                {opinionError ? <p className="text-xs text-destructive">{opinionError}</p> : null}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeAction} disabled={submitting}>
              取消
            </Button>
            <Button
              variant={mode === 'reject' ? 'destructive' : 'default'}
              onClick={() => void submitAction()}
              disabled={submitting}
            >
              {submitting ? '提交中…' : mode === 'approve' ? '确认通过' : '确认驳回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
