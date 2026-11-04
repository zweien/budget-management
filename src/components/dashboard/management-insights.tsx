'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowRight,
  CalendarClock,
  Gauge,
  Inbox,
  SlidersHorizontal,
  TrendingUp,
} from 'lucide-react';

import { apiFetch } from '@/lib/api/client';
import {
  DEFAULT_DASH_THRESHOLDS,
  readDashThresholds,
  writeDashThresholds,
  type DashThresholds,
} from '@/lib/ui-prefs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/layout/empty-state';
import { Input } from '@/components/ui/input';
import { MoneyText } from '@/components/ui/MoneyText';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableEmpty, TablePagination } from '@/components/ui/table-pagination';

/**
 * 工作台「管理决策」区:月度执行趋势 + 三类决策信号卡(应结题/执行率不足/超支)。
 * 数据一次取回(GET /api/statistics/management-overview,全局只读);
 * 执行率分级着色线(warn/danger)为个人偏好,cookie 持久化(bm-dash-thresholds)。
 */

const TOP_N = 8;

interface ManagementRow {
  projectId: string;
  code: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  currentBudget: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
  timeProgress: number | null;
  remainingDays: number | null;
}

interface TrendBucket {
  month: string; // yyyy-MM
  paid: string;
  payable: string;
  totalOccupied: string;
}

interface OverviewData {
  year: number;
  monthlyTrend: TrendBucket[];
  dueForCompletion: ManagementRow[];
  executionLagging: ManagementRow[];
  overspend: ManagementRow[];
}

function renderRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/** 执行率着色:低于 warn 预警 / warn~danger 警示 / 高于 danger 正常。 */
function rateColor(rate: number | null | undefined, th: DashThresholds): string {
  if (rate === null || rate === undefined) return 'var(--muted-foreground)';
  const pct = rate * 100;
  if (pct < th.warn) return 'var(--destructive)';
  if (pct < th.danger) return 'var(--warning)';
  return 'var(--primary)';
}

/** 行内 HTML 执行率条(超 100% 封顶展示,右侧数字照实)。 */
function MiniRateBar({ rate, th }: { rate: number | null; th: DashThresholds }) {
  const pct = rate === null ? null : rate * 100;
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${width}%`, background: rateColor(rate, th) }}
        />
      </div>
      <span className="w-14 text-right text-xs tabular-nums" style={{ color: rateColor(rate, th) }}>
        {pct === null ? '—' : `${pct.toFixed(1)}%`}
      </span>
    </div>
  );
}

function ProjectLink({ row }: { row: ManagementRow }) {
  return (
    <Link
      href={`/projects/${row.projectId}`}
      className="text-link transition-colors hover:text-link-deep"
      title={`${row.code} · ${row.name}`}
    >
      {row.name}
    </Link>
  );
}

// ============================================================
// 月度执行趋势(recharts 堆叠柱:已支出 + 应付未付)
// ============================================================
function MonthlyTrendChart({ trend }: { trend: TrendBucket[] }) {
  const data = useMemo(
    () =>
      trend.map((t) => ({
        month: `${t.month.slice(5)}月`,
        paid: Number(t.paid),
        payable: Number(t.payable),
      })),
    [trend],
  );
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          barCategoryGap="25%"
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="month"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={56}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickFormatter={(v: number) => (v >= 10000 ? `${(v / 10000).toFixed(0)}万` : String(v))}
          />
          <Tooltip
            cursor={{ fill: 'var(--accent)' }}
            formatter={(value, name) => [
              Number(value).toLocaleString('zh-CN', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }),
              String(name),
            ]}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--popover-foreground)',
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar
            dataKey="paid"
            name="已支出"
            stackId="occ"
            fill="var(--primary)"
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="payable"
            name="应付未付"
            stackId="occ"
            fill="var(--warning)"
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ============================================================
// 阈值设置弹层(cookie 持久化,即时生效)
// ============================================================
function ThresholdsPopover({
  thresholds,
  onChange,
}: {
  thresholds: DashThresholds;
  onChange: (next: DashThresholds) => void;
}) {
  // Popover 内容随开合挂载/卸载,打开即取外部最新值(重置后再次打开同步)。
  const [warn, setWarn] = useState(String(thresholds.warn));
  const [danger, setDanger] = useState(String(thresholds.danger));
  const apply = () => {
    const w = Number.parseInt(warn, 10);
    const d = Number.parseInt(danger, 10);
    if (Number.isInteger(w) && Number.isInteger(d) && w >= 0 && w < d && d <= 100) {
      onChange({ warn: w, danger: d });
    }
  };
  const valid = (() => {
    const w = Number.parseInt(warn, 10);
    const d = Number.parseInt(danger, 10);
    return Number.isInteger(w) && Number.isInteger(d) && w >= 0 && w < d && d <= 100;
  })();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <SlidersHorizontal />
          分级线 {thresholds.warn}% / {thresholds.danger}%
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="caption-mono mb-2">执行率分级线(个人偏好)</p>
        <div className="space-y-2">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">预警线(低于此值,红)</span>
            <Input
              className="h-8 w-20 text-right"
              type="number"
              min={0}
              max={99}
              value={warn}
              onChange={(e) => setWarn(e.target.value)}
              onBlur={apply}
              aria-label="预警线百分比"
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">达标线(高于此值,蓝)</span>
            <Input
              className="h-8 w-20 text-right"
              type="number"
              min={1}
              max={100}
              value={danger}
              onChange={(e) => setDanger(e.target.value)}
              onBlur={apply}
              aria-label="达标线百分比"
            />
          </label>
          {!valid ? (
            <p className="text-xs text-destructive">须为 0~100 的整数,且预警线 &lt; 达标线</p>
          ) : (
            <p className="text-xs text-mute">介于两线之间为警示色(黄);仅影响着色,不改判定。</p>
          )}
          <div className="flex justify-end pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setWarn(String(DEFAULT_DASH_THRESHOLDS.warn));
                setDanger(String(DEFAULT_DASH_THRESHOLDS.danger));
                onChange(DEFAULT_DASH_THRESHOLDS);
              }}
            >
              重置默认(50 / 80)
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================
// 全量清单 Sheet(三卡共用;分页表格)
// ============================================================
type SignalKind = 'due' | 'lagging' | 'overspend';

function SignalSheet({
  kind,
  rows,
  open,
  onOpenChange,
  thresholds,
}: {
  kind: SignalKind | null;
  rows: ManagementRow[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  thresholds: DashThresholds;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const paged = rows.slice(page * pageSize, page * pageSize + pageSize);
  const title =
    kind === 'due'
      ? '应结题项目(全量)'
      : kind === 'lagging'
        ? '执行率不足项目(全量)'
        : '超支项目(全量)';
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) setPage(0); // 关闭时复位分页(事件处理器内;下次打开从头看)。
        onOpenChange(o);
      }}
    >
      <SheetContent className="w-full overflow-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {kind === 'due'
              ? '结束日期在本年度年末前的未归档项目(逾期在前);点击项目名进入项目台账。'
              : kind === 'lagging'
                ? '执行率低于时间进度(按起止日期)的项目,差距降序;点击项目名进入项目台账。'
                : '总结余(现行总预算 − 总占用)为负的项目,缺口大者在前;点击项目名进入项目台账。'}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>项目</TableHead>
                {kind === 'due' ? <TableHead className="w-32">结束日期</TableHead> : null}
                {kind === 'due' ? <TableHead className="w-28">剩余</TableHead> : null}
                {kind === 'lagging' ? (
                  <TableHead className="w-28 text-right">时间进度</TableHead>
                ) : null}
                {kind === 'overspend' ? (
                  <TableHead className="w-36 text-right">总结余</TableHead>
                ) : null}
                <TableHead className="w-36">执行率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.length === 0 ? (
                <TableEmpty colSpan={kind === 'due' ? 4 : 3}>无匹配项目</TableEmpty>
              ) : (
                paged.map((r) => (
                  <TableRow key={r.projectId}>
                    <TableCell>
                      <ProjectLink row={r} />
                    </TableCell>
                    {kind === 'due' ? (
                      <TableCell className="tabular-nums">{r.endDate ?? '—'}</TableCell>
                    ) : null}
                    {kind === 'due' ? (
                      <TableCell>
                        <RemainingDaysBadge row={r} />
                      </TableCell>
                    ) : null}
                    {kind === 'lagging' ? (
                      <TableCell className="text-right tabular-nums">
                        {renderRate(r.timeProgress)}
                      </TableCell>
                    ) : null}
                    {kind === 'overspend' ? (
                      <TableCell className="text-right">
                        <MoneyText value={r.balance} />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <MiniRateBar rate={r.executionRate} th={thresholds} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={rows.length}
            loading={false}
            onPageChange={setPage}
            onPageSizeChange={(ps) => {
              setPageSize(ps);
              setPage(0);
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RemainingDaysBadge({ row }: { row: ManagementRow }) {
  if (row.remainingDays === null) return <span className="text-mute">—</span>;
  const d = row.remainingDays;
  if (d < 0) return <Badge variant="error">逾期 {-d} 天</Badge>;
  if (d <= 90) return <Badge variant="warning">剩 {d} 天</Badge>;
  return <span className="text-xs text-mute tabular-nums">剩 {d} 天</span>;
}

// ============================================================
// 主组件:管理决策区
// ============================================================
export function ManagementInsights() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [thresholds, setThresholds] = useState<DashThresholds>(DEFAULT_DASH_THRESHOLDS);
  const [sheetKind, setSheetKind] = useState<SignalKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<OverviewData>('/api/statistics/management-overview')
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载管理决策数据失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 挂载后读个人阈值偏好(rAF 派发,通过 set-state-in-effect 规则;
  // 与列显隐偏好的回落路径同款)。
  useEffect(() => {
    const raf = requestAnimationFrame(() => setThresholds(readDashThresholds()));
    return () => cancelAnimationFrame(raf);
  }, []);

  const updateThresholds = (next: DashThresholds) => {
    setThresholds(next);
    writeDashThresholds(next);
  };

  if (error) {
    return (
      <section className="space-y-3">
        <h2 className="text-base font-bold tracking-[-0.025em]">管理决策</h2>
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </section>
    );
  }

  if (loading || !data) {
    return (
      <section className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-56 w-full" />
        <div className="grid gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-64 w-full" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold tracking-[-0.025em]">管理决策</h2>
        <ThresholdsPopover thresholds={thresholds} onChange={updateThresholds} />
      </div>

      {/* 月度执行趋势 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="size-4 text-mute" />
            月度执行趋势(近 12 个月 · 全部项目)
          </CardTitle>
          <span className="text-xs text-mute">按申请日期所在月;已支出 + 应付未付</span>
        </CardHeader>
        <CardContent>
          <MonthlyTrendChart trend={data.monthlyTrend} />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* 应结题 */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="size-4 text-mute" />
              应结题({data.year} 年)
            </CardTitle>
            <Badge variant={data.dueForCompletion.length ? 'warning' : 'success'}>
              {data.dueForCompletion.length} 项
            </Badge>
          </CardHeader>
          <CardContent className="space-y-1">
            <SignalList
              rows={data.dueForCompletion.slice(0, TOP_N)}
              total={data.dueForCompletion.length}
              kind="due"
              thresholds={thresholds}
              onShowAll={() => setSheetKind('due')}
            />
          </CardContent>
        </Card>

        {/* 执行率不足 */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Gauge className="size-4 text-mute" />
              执行率不足
            </CardTitle>
            <Badge variant={data.executionLagging.length ? 'error' : 'success'}>
              {data.executionLagging.length} 项
            </Badge>
          </CardHeader>
          <CardContent className="space-y-1">
            <SignalList
              rows={data.executionLagging.slice(0, TOP_N)}
              total={data.executionLagging.length}
              kind="lagging"
              thresholds={thresholds}
              onShowAll={() => setSheetKind('lagging')}
            />
          </CardContent>
        </Card>

        {/* 超支 */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="size-4 rotate-180 text-mute" />
              超支项目
            </CardTitle>
            <Badge variant={data.overspend.length ? 'error' : 'success'}>
              {data.overspend.length} 项
            </Badge>
          </CardHeader>
          <CardContent className="space-y-1">
            <SignalList
              rows={data.overspend.slice(0, TOP_N)}
              total={data.overspend.length}
              kind="overspend"
              thresholds={thresholds}
              onShowAll={() => setSheetKind('overspend')}
            />
          </CardContent>
        </Card>
      </div>

      <SignalSheet
        kind={sheetKind}
        open={sheetKind !== null}
        onOpenChange={(o) => !o && setSheetKind(null)}
        rows={
          sheetKind === 'due'
            ? data.dueForCompletion
            : sheetKind === 'lagging'
              ? data.executionLagging
              : data.overspend
        }
        thresholds={thresholds}
      />
    </section>
  );
}

/** 卡内紧凑行列表(Top N):应结题/超支为行式列表;执行率不足用 recharts 横向双条。 */
function SignalList({
  rows,
  total,
  kind,
  thresholds,
  onShowAll,
}: {
  rows: ManagementRow[];
  total: number;
  kind: SignalKind;
  thresholds: DashThresholds;
  onShowAll: () => void;
}) {
  if (rows.length === 0) {
    return <EmptyState icon={<Inbox />} title="暂无信号" className="py-10" />;
  }
  return (
    <>
      {kind === 'lagging' ? (
        <LaggingChart rows={rows} th={thresholds} />
      ) : (
        <div className="space-y-0.5">
          {rows.map((r) => (
            <div
              key={r.projectId}
              className="flex items-center justify-between gap-2 rounded-sm px-1 py-1.5 hover:bg-accent/50"
            >
              <div className="flex min-w-0 items-center gap-2">
                {kind === 'due' ? <RemainingDaysBadge row={r} /> : null}
                <ProjectLink row={r} />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {kind === 'due' ? (
                  <span className="text-xs text-mute tabular-nums">{r.endDate}</span>
                ) : (
                  <MoneyText value={r.balance} className="text-xs" />
                )}
                <MiniRateBar rate={r.executionRate} th={thresholds} />
              </div>
            </div>
          ))}
        </div>
      )}
      {total > rows.length ? (
        <Button variant="ghost" size="sm" className="w-full" onClick={onShowAll}>
          查看全部 {total} 项
          <ArrowRight className="size-4" />
        </Button>
      ) : null}
    </>
  );
}

/** 执行率不足:横向条形图(执行率按分级着色 + 时间进度参照条),recharts。 */
function LaggingChart({ rows, th }: { rows: ManagementRow[]; th: DashThresholds }) {
  const data = rows.map((r) => ({
    name: r.name.length > 8 ? `${r.name.slice(0, 8)}…` : r.name,
    rate: r.executionRate === null ? 0 : Number((r.executionRate * 100).toFixed(1)),
    progress: r.timeProgress === null ? 0 : Number((r.timeProgress * 100).toFixed(1)),
  }));
  const height = Math.max(160, 36 + rows.length * 36);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis
            type="number"
            domain={[0, (max: number) => Math.max(100, Math.ceil(max / 10) * 10)]}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickFormatter={(v: number) => `${v}%`}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={96}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: 'var(--foreground)' }}
          />
          <Tooltip
            cursor={{ fill: 'var(--accent)' }}
            formatter={(value, name) => [`${Number(value)}%`, String(name)]}
            contentStyle={{
              background: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--popover-foreground)',
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar
            dataKey="progress"
            name="时间进度"
            fill="var(--muted-foreground)"
            fillOpacity={0.35}
            radius={[0, 3, 3, 0]}
          />
          <Bar dataKey="rate" name="执行率" radius={[0, 3, 3, 0]}>
            {data.map((d) => (
              <Cell key={d.name} fill={rateColor(d.rate / 100, th)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
