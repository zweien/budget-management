'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Inbox } from 'lucide-react';

import { apiFetch } from '@/lib/api/client';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/layout/empty-state';
import { MoneyText } from '@/components/ui/MoneyText';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface CurrentUser {
  id: string;
  name: string;
  role: string;
}

interface ProjectRef {
  id: string;
  code: string;
  name: string;
}

// ---- cross-project(管理员聚合)----
interface CrossProjectRow {
  projectId: string;
  name: string;
  currentBudget: string;
  totalOccupied: string;
  paid: string;
  balance: string;
  executionRate: number | null;
}
interface CrossProjectResult {
  projects: CrossProjectRow[];
}

// ---- ledger(非管理员聚合 + 风险预警:逐项目查当年科目)----
interface LedgerNode {
  subjectId: string;
  code: string;
  name: string;
  isLeaf: boolean;
  current: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
}
interface LedgerResponse {
  year: number;
  nodes: LedgerNode[];
}

// ---- 待审批事项(admin)----
interface PendingResponse {
  initialBudgets: unknown[];
  adjustments: unknown[];
  subjectChanges: unknown[];
}

/** 渲染执行率为百分比。 */
function renderRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(2)}%`;
}

/** 指标数值:display-md 字级 + tabular-nums(DESIGN.md 负字距标题字重 600)。 */
function MetricValue({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-display-md tabular-nums">{children}</p>;
}

export default function DashboardPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<CurrentUser>('/api/me')
      .then((u) => {
        if (!cancelled) setCurrentUser(u);
      })
      .catch(() => {
        // me 失败通常意味着未登录,不阻塞布局;下方渲染降级提示。
      })
      .finally(() => {
        if (!cancelled) setLoadingUser(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadingUser) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (!currentUser) {
    return (
      <Alert variant="warning">
        <AlertTitle>未登录</AlertTitle>
        <AlertDescription>无法获取当前用户身份,请刷新页面或在右上角切换用户。</AlertDescription>
      </Alert>
    );
  }

  const isAdmin = currentUser.role === 'BUDGET_ADMIN';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Dashboard"
        title="工作台"
        description={`欢迎回来,${currentUser.name}(§12.1 项目概览 / 预算指标 / 风险预警 / 待办)`}
      />

      <ProjectOverview isAdmin={isAdmin} />
      <BudgetMetricCards isAdmin={isAdmin} />
      <RiskWarnings isAdmin={isAdmin} />
      {isAdmin ? <PendingApprovals /> : null}
    </div>
  );
}

// ============================================================
// 1) 项目概览(§12.1)
// ============================================================
function ProjectOverview({ isAdmin }: { isAdmin: boolean }) {
  // 管理员:cross-project 一次取回项目数;非 admin:/api/projects 取可访问项目列表。
  const [rows, setRows] = useState<ProjectRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const promise = isAdmin
      ? apiFetch<CrossProjectResult>('/api/statistics/cross-project').then((r) =>
          r.projects.map((p) => ({ id: p.projectId, code: '', name: p.name })),
        )
      : apiFetch<ProjectRef[]>('/api/projects').then((list) => list ?? []);
    promise
      .then((list) => {
        if (!cancelled) {
          setRows(list);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载项目失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>项目概览</CardTitle>
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-sm text-link transition-colors hover:text-link-deep"
        >
          进入项目管理
          <ArrowRight className="size-4" />
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-12 w-40" />
        ) : error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2">
            <MetricValue>{rows.length}</MetricValue>
            <p className="text-sm text-muted-foreground">
              {isAdmin ? '全部项目数' : '可访问项目数'}
              {!isAdmin && rows.length > 0
                ? `:${rows
                    .slice(0, 5)
                    .map((r) => r.name)
                    .join('、')}${rows.length > 5 ? ` 等 ${rows.length} 个` : ''}`
                : ''}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// 2) 预算指标卡片(§12.1)
//    - admin:cross-project 聚合(一次请求)
//    - 非 admin:逐项目取 ledger(当年)汇总叶节点(项目数通常不多,可接受)
// ============================================================
interface Metrics {
  currentBudget: string;
  totalOccupied: string;
  executionRate: number | null;
  balance: string;
}

function BudgetMetricCards({ isAdmin }: { isAdmin: boolean }) {
  const year = new Date().getFullYear();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const compute = async (): Promise<Metrics> => {
      if (isAdmin) {
        // 管理员:cross-project 一次取回所有项目行,前端再聚合。
        const data = await apiFetch<CrossProjectResult>(
          `/api/statistics/cross-project?year=${year}`,
        );
        return aggregateCross(data.projects);
      }
      // 非 admin:取可访问项目 → 逐项目 ledger(当年)。
      const projects = await apiFetch<ProjectRef[]>('/api/projects');
      const ledgers = await Promise.all(
        (projects ?? []).map((p) =>
          apiFetch<LedgerResponse>(`/api/projects/${p.id}/ledger?year=${year}`).catch(() => null),
        ),
      );
      return aggregateLedgers(ledgers.filter((l): l is LedgerResponse => l !== null));
    };

    compute()
      .then((m) => {
        if (!cancelled) {
          setMetrics(m);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载预算指标失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, year]);

  if (error) {
    return (
      <Alert variant="error">
        <AlertDescription>预算指标:{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold tracking-[-0.3px]">预算指标({year} 年)</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {loading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="mt-2 h-8 w-24" />
            </Card>
          ))
        ) : (
          <>
            <Card className="p-4">
              <p className="caption-mono">当前预算</p>
              <MetricValue>
                <MoneyText
                  value={metrics.currentBudget}
                  riskOnNegative={false}
                  className="text-left"
                />
              </MetricValue>
            </Card>
            <Card className="p-4">
              <p className="caption-mono">总占用</p>
              <MetricValue>
                <MoneyText
                  value={metrics.totalOccupied}
                  riskOnNegative={false}
                  className="text-left"
                />
              </MetricValue>
            </Card>
            <Card className="p-4">
              <p className="caption-mono">执行率</p>
              <MetricValue>{renderRate(metrics.executionRate)}</MetricValue>
            </Card>
            <Card className="p-4">
              <p className="caption-mono">总结余</p>
              <MetricValue>
                <MoneyText value={metrics.balance} className="text-left" />
              </MetricValue>
            </Card>
          </>
        )}
      </div>
    </section>
  );
}

/** 把 cross-project 各行金额求和(字符串 → 求和 → 字符串)。 */
function aggregateCross(rows: CrossProjectRow[]): Metrics {
  let budget = 0;
  let occupied = 0;
  for (const r of rows) {
    budget += Number.parseFloat(r.currentBudget ?? '0') || 0;
    occupied += Number.parseFloat(r.totalOccupied ?? '0') || 0;
  }
  const balance = budget - occupied;
  return {
    currentBudget: budget.toFixed(2),
    totalOccupied: occupied.toFixed(2),
    balance: balance.toFixed(2),
    executionRate: budget > 0 ? occupied / budget : null,
  };
}

/** 把若干 ledger 的叶节点金额求和(只取 isLeaf=true 的节点,避免与父节点重复)。 */
function aggregateLedgers(ledgers: LedgerResponse[]): Metrics {
  let budget = 0;
  let occupied = 0;
  for (const ledger of ledgers) {
    for (const n of ledger.nodes) {
      if (n.isLeaf) {
        budget += Number.parseFloat(n.current ?? '0') || 0;
        occupied += Number.parseFloat(n.totalOccupied ?? '0') || 0;
      }
    }
  }
  const balance = budget - occupied;
  return {
    currentBudget: budget.toFixed(2),
    totalOccupied: occupied.toFixed(2),
    balance: balance.toFixed(2),
    executionRate: budget > 0 ? occupied / budget : null,
  };
}

// ============================================================
// 3) 风险预警(§12.1):负结余(超预算)的科目
// ============================================================
interface RiskRow {
  key: string;
  projectId: string;
  projectName: string;
  subjectCode: string;
  subjectName: string;
  balance: string;
  executionRate: number | null;
}

function RiskWarnings({ isAdmin }: { isAdmin: boolean }) {
  const year = new Date().getFullYear();
  const [risks, setRisks] = useState<RiskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const compute = async (): Promise<RiskRow[]> => {
      // admin 与非 admin 均通过 /api/projects 取得其可见项目(admin 全部,非 admin 可访问)。
      const projects = await apiFetch<ProjectRef[]>('/api/projects');
      const items = await Promise.all(
        (projects ?? []).map((p) =>
          apiFetch<LedgerResponse>(`/api/projects/${p.id}/ledger?year=${year}`)
            .then((l) => ({ project: p, ledger: l }))
            .catch(() => null),
        ),
      );
      const out: RiskRow[] = [];
      for (const item of items) {
        if (!item) continue;
        for (const n of item.ledger.nodes) {
          const bal = Number.parseFloat(n.balance ?? '0');
          if (Number.isFinite(bal) && bal < 0) {
            out.push({
              key: `${item.project.id}-${n.subjectId}`,
              projectId: item.project.id,
              projectName: item.project.name,
              subjectCode: n.code,
              subjectName: n.name,
              balance: n.balance,
              executionRate: n.executionRate,
            });
          }
        }
      }
      // 按结余升序(最负在前)。
      out.sort((a, b) => Number.parseFloat(a.balance) - Number.parseFloat(b.balance));
      return out;
    };

    compute()
      .then((rows) => {
        if (!cancelled) {
          setRisks(rows);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载风险预警失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, year]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>风险预警</CardTitle>
        <Badge variant={risks.length ? 'error' : 'success'}>{risks.length} 项</Badge>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : risks.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title={`暂无负结余(超预算)科目(${year} 年)`}
            className="py-10"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>项目</TableHead>
                <TableHead className="w-32">科目编码</TableHead>
                <TableHead>科目名称</TableHead>
                <TableHead className="w-40 text-right">结余</TableHead>
                <TableHead className="w-28 text-right">执行率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {risks.map((r) => (
                <TableRow key={r.key}>
                  <TableCell>
                    <Link
                      href={`/projects/${r.projectId}`}
                      className="text-link transition-colors hover:text-link-deep"
                    >
                      {r.projectName}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{r.subjectCode}</TableCell>
                  <TableCell>{r.subjectName}</TableCell>
                  <TableCell>
                    <MoneyText value={r.balance} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {renderRate(r.executionRate)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// 4) 待审批事项(§12.1, admin only)
// ============================================================
function PendingApprovals() {
  const [pending, setPending] = useState<PendingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PendingResponse>('/api/approvals/pending')
      .then((data) => {
        if (!cancelled) {
          setPending(data);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载待办失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    const initial = pending?.initialBudgets.length ?? 0;
    const adjust = pending?.adjustments.length ?? 0;
    const subject = pending?.subjectChanges.length ?? 0;
    return { initial, adjust, subject, total: initial + adjust + subject };
  }, [pending]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>待审批事项</CardTitle>
        <Link
          href="/approvals"
          className="inline-flex items-center gap-1 text-sm text-link transition-colors hover:text-link-deep"
        >
          进入审批中心
          <ArrowRight className="size-4" />
        </Link>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-12 w-full" />
        ) : error ? (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : counts.total === 0 ? (
          <EmptyState icon={<Inbox />} title="暂无待审批事项" className="py-10" />
        ) : (
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="caption-mono">初始预算编制</p>
              <MetricValue>{counts.initial}</MetricValue>
            </div>
            <div>
              <p className="caption-mono">预算调整</p>
              <MetricValue>{counts.adjust}</MetricValue>
            </div>
            <div>
              <p className="caption-mono">科目变更</p>
              <MetricValue>{counts.subject}</MetricValue>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
