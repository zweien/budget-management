'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { MoneyText } from '@/components/ui/MoneyText';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

/** 状态展示语义色遵循 DESIGN.md;导出供调整列表页复用,避免两份定义漂移。 */
export const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
};

export const STATUS_BADGE: Record<
  string,
  'secondary' | 'warning' | 'success' | 'error' | 'outline'
> = {
  DRAFT: 'secondary',
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  WITHDRAWN: 'outline',
};

/** GET /adjustments/:id 返回的 detail(与服务端 AdjustmentDetail 对应,金额为元字符串)。 */
export interface AdjustmentDetailVO {
  id: string;
  projectId: string;
  year: number;
  kind: 'ADJUST' | 'ALLOCATE';
  expandTotals: boolean;
  status: string;
  totalReason: string | null;
  annualReason: string | null;
  createdAt: string;
  lines: {
    id: string;
    subjectId: string | null;
    subjectName: string | null;
    subjectCode: string | null;
    isNew: boolean;
    newSubjectName: string | null;
    newSubjectParentName: string | null;
    totalAdjustment: string;
    annualAdjustment: string;
    originTotal: string;
    originAnnual: string;
    afterTotal: string;
    afterAnnual: string;
  }[];
  sums: {
    originTotal: string;
    originAnnual: string;
    adjustTotal: string;
    adjustAnnual: string;
    afterTotal: string;
    afterAnnual: string;
  };
}

/** 父级已持有的行摘要:明细拉取失败/缺失时的降级展示数据。 */
export interface AdjustmentSummaryFallback {
  year: number;
  kind?: 'ADJUST' | 'ALLOCATE';
  expandTotals?: boolean;
  status: string;
  totalReason?: string | null;
  annualReason?: string | null;
  createdAt?: string | null;
}

interface AdjustmentDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** 懒加载目标;null 时 Sheet 关闭。 */
  adjustmentId: string | null;
  /** 头部申请人名(父级上下文已有,避免服务端再 include)。 */
  applicantName?: string;
  /** 降级展示用的行摘要(明细不可得时仍展示年度/类型/状态/原因/申请人)。 */
  fallback?: AdjustmentSummaryFallback | null;
  /**
   * 就地办理(§issue15,审批中心传入):校验意见后回调;
   * resolve = 成功(父级负责关 Sheet + 刷新列表),reject = 失败(保持打开)。
   */
  onAction?: (mode: 'approve' | 'reject', opinion: string) => Promise<void>;
}

/**
 * 调整单只读明细 Sheet(§issue15):项目内调整列表与审批中心共用同一实现。
 *
 * - 明细经现有详情接口懒加载(GET /adjustments/:id 的 `detail`,含基线重建的
 *   原预算/调整后金额与双维度合计);加载失败时优雅降级:仍展示父级已知的
 *   年度/类型/状态/原因/申请人,明细区给出重试入口。
 * - 传入 `onAction` 时底部出现 意见输入 + 审批/驳回(驳回必填意见),
 *   与审批中心原有 Dialog 同一套交互约定。
 */
export function AdjustmentDetailSheet({
  open,
  onOpenChange,
  projectId,
  adjustmentId,
  applicantName,
  fallback,
  onAction,
}: AdjustmentDetailSheetProps) {
  const [detail, setDetail] = useState<AdjustmentDetailVO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // 就地办理状态。
  const [opinion, setOpinion] = useState('');
  const [opinionError, setOpinionError] = useState<string | null>(null);
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    if (!open || !adjustmentId) return;
    let cancelled = false;
    apiFetch<{ detail: AdjustmentDetailVO }>(
      `/api/projects/${projectId}/adjustments/${adjustmentId}`,
    )
      .then((res) => {
        if (!cancelled) {
          setDetail(res.detail);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setDetail(null);
          setError(e instanceof Error ? e.message : '加载明细失败');
        }
      });
    return () => {
      cancelled = true;
      setDetail(null);
      setError(null);
      setOpinion('');
      setOpinionError(null);
    };
  }, [open, adjustmentId, projectId, attempt]);

  const doAction = async (mode: 'approve' | 'reject') => {
    const trimmed = opinion.trim();
    if (mode === 'reject' && !trimmed) {
      setOpinionError('请填写驳回意见');
      return;
    }
    if (!onAction) return;
    setActing(mode);
    try {
      await onAction(mode, trimmed);
      // 成功后由父级关闭 Sheet;这里不动状态。
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败');
    } finally {
      setActing(null);
    }
  };

  // 明细拉取成功用 detail;失败/缺失降级为父级 fallback。
  const year = detail?.year ?? fallback?.year;
  const kind = detail?.kind ?? fallback?.kind;
  const expandTotals = detail?.expandTotals ?? fallback?.expandTotals;
  const totalReason = detail?.totalReason ?? fallback?.totalReason ?? null;
  const annualReason = detail?.annualReason ?? fallback?.annualReason ?? null;
  const createdAt = detail?.createdAt ?? fallback?.createdAt ?? null;
  const loading = open && !!adjustmentId && !detail && !error;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-6 sm:max-w-2xl">
        <SheetHeader className="p-0 pb-4">
          <SheetTitle>
            调整单明细{year !== undefined ? ` · ${year} 年度` : ''}
            {fallback ? `(${STATUS_LABEL[fallback.status] ?? fallback.status})` : ''}
          </SheetTitle>
        </SheetHeader>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border">
              {year !== undefined && (
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">年度</dt>
                  <dd className="mt-1 text-sm tabular-nums">{year}</dd>
                </div>
              )}
              {kind && (
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">类型</dt>
                  <dd className="mt-1 text-sm">
                    {kind === 'ALLOCATE' ? (
                      <>
                        <Badge variant="outline" className="mr-1.5 align-middle">
                          追加下达
                        </Badge>
                        <span className="text-mute">
                          {expandTotals
                            ? '新经费入账:通过后将调增科目总预算与项目总预算'
                            : '池内分配:各层总额不变,仅落地到年份'}
                        </span>
                      </>
                    ) : (
                      '预算调剂'
                    )}
                  </dd>
                </div>
              )}
              {applicantName && (
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">申请人</dt>
                  <dd className="mt-1 text-sm">{applicantName}</dd>
                </div>
              )}
              <div className="bg-card p-3">
                <dt className="text-xs text-mute">总预算调整原因</dt>
                <dd className="mt-1 text-sm">{totalReason || '—'}</dd>
              </div>
              <div className="bg-card p-3">
                <dt className="text-xs text-mute">年度预算调整原因</dt>
                <dd className="mt-1 text-sm">{annualReason || '—'}</dd>
              </div>
              {createdAt && (
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">创建时间</dt>
                  <dd className="mt-1 text-sm tabular-nums">{formatDateTime(createdAt)}</dd>
                </div>
              )}
            </dl>

            {error ? (
              <div className="flex flex-col items-start gap-2">
                <p role="alert" className="text-sm text-error-deep">
                  明细加载失败:{error}
                </p>
                <Button variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
                  重试
                </Button>
              </div>
            ) : detail ? (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>预算科目</TableHead>
                      <TableHead className="text-right">原预算(总/年)</TableHead>
                      <TableHead className="text-right">调整额(总/年)</TableHead>
                      <TableHead className="text-right">调整后(总/年)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.lines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>
                          {l.isNew ? (
                            <span>
                              <Badge variant="warning" className="mr-1.5 align-middle">
                                新
                              </Badge>
                              {l.newSubjectName}
                              {l.newSubjectParentName && (
                                <span className="text-mute">(挂靠:{l.newSubjectParentName})</span>
                              )}
                            </span>
                          ) : (
                            <span>
                              {l.subjectCode && (
                                <span className="mr-1.5 font-mono text-[13px] text-mute">
                                  {l.subjectCode}
                                </span>
                              )}
                              {l.subjectName ?? '—'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <MoneyText value={l.originTotal} riskOnNegative={false} />
                          <span className="mx-1 text-mute">/</span>
                          <MoneyText value={l.originAnnual} riskOnNegative={false} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <MoneyText value={l.totalAdjustment} riskOnNegative={false} />
                          <span className="mx-1 text-mute">/</span>
                          <MoneyText value={l.annualAdjustment} riskOnNegative={false} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <MoneyText value={l.afterTotal} riskOnNegative={false} />
                          <span className="mx-1 text-mute">/</span>
                          <MoneyText value={l.afterAnnual} riskOnNegative={false} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow className="hover:bg-transparent">
                      <TableCell>合计</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <MoneyText value={detail.sums.originTotal} riskOnNegative={false} />
                        <span className="mx-1 text-mute">/</span>
                        <MoneyText value={detail.sums.originAnnual} riskOnNegative={false} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <MoneyText value={detail.sums.adjustTotal} riskOnNegative={false} />
                        <span className="mx-1 text-mute">/</span>
                        <MoneyText value={detail.sums.adjustAnnual} riskOnNegative={false} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <MoneyText value={detail.sums.afterTotal} riskOnNegative={false} />
                        <span className="mx-1 text-mute">/</span>
                        <MoneyText value={detail.sums.afterAnnual} riskOnNegative={false} />
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            ) : null}

            {/* 就地办理(审批中心):意见 + 审批/驳回 */}
            {onAction && (
              <div className="grid gap-2 rounded-lg border border-border p-3">
                <Label htmlFor="adj-detail-opinion">审批意见</Label>
                <Textarea
                  id="adj-detail-opinion"
                  rows={3}
                  placeholder="通过可选填写意见;驳回必填原因"
                  value={opinion}
                  onChange={(e) => {
                    setOpinion(e.target.value);
                    if (opinionError) setOpinionError(null);
                  }}
                  aria-invalid={!!opinionError}
                />
                {opinionError ? <p className="text-xs text-destructive">{opinionError}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={acting !== null}
                    onClick={() => void doAction('reject')}
                  >
                    {acting === 'reject' ? '驳回中…' : '驳回'}
                  </Button>
                  <Button
                    size="sm"
                    disabled={acting !== null}
                    onClick={() => void doAction('approve')}
                  >
                    {acting === 'approve' ? '审批中…' : '审批通过'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
