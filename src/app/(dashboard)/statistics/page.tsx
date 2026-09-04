'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Download, RotateCcw, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { DateRange } from 'react-day-picker';

import { apiFetch, downloadFile } from '@/lib/api/client';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyText } from '@/components/ui/MoneyText';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ---- §8 业务记录四态(与 Prisma BusinessStatus 同步,不依赖运行时枚举,
//      避免 client bundle 强引 @prisma/client)。 ----
const BUSINESS_STATUSES = ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID'] as const;
type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

const STATUS_LABEL: Record<BusinessStatus, string> = {
  PLACEHOLDER: '登记占位',
  CONTRACT: '合同',
  FINANCE_APPROVAL: '财务系统审批',
  PAID: '已支出',
};

/** Badge 语义色遵循 DESIGN.md。 */
const STATUS_BADGE: Record<BusinessStatus, 'secondary' | 'outline' | 'warning' | 'success'> = {
  PLACEHOLDER: 'secondary',
  CONTRACT: 'outline',
  FINANCE_APPROVAL: 'warning',
  PAID: 'success',
};

// ---- 通用类型 ----

interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

/** 生成最近 5 年的年度选项(含当前年,按降序)。 */
function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

/** 把 businessDate(可能是 ISO 或带 T 的字符串)统一为 YYYY-MM-DD 展示。 */
function formatDate(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd');
}

/** 把执行率(number|null)渲染为百分比。 */
function renderRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(2)}%`;
}

/** Select 的"全部/清除"哨兵值(radix SelectItem 不允许空串)。 */
const ALL = '__all__';

// ============================================================
// 主组件
// ============================================================
export default function StatisticsPage() {
  // v0.3.0 起普通用户全局只读:三个统计 tab 对所有登录用户开放,无需角色门控。
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Statistics"
        title="统计分析"
        description="自定义统计、月度历史、跨项目汇总(§11.3-11.5)。"
      />

      <Tabs defaultValue="custom">
        <TabsList>
          <TabsTrigger value="custom">自定义统计</TabsTrigger>
          <TabsTrigger value="monthly">月度历史</TabsTrigger>
          <TabsTrigger value="cross">跨项目统计</TabsTrigger>
          <TabsTrigger value="balance">经费余额</TabsTrigger>
        </TabsList>
        <TabsContent value="custom">
          <CustomStatisticsTab />
        </TabsContent>
        <TabsContent value="monthly">
          <MonthlyHistoryTab />
        </TabsContent>
        <TabsContent value="cross">
          <CrossProjectTab />
        </TabsContent>
        <TabsContent value="balance">
          <BalanceTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ============================================================
// 加载可访问项目(三个 tab 共用)
// ============================================================
function useAccessibleProjects(): {
  projects: ProjectOption[];
  loading: boolean;
} {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectOption[]>('/api/projects')
      .then((rows) => {
        if (!cancelled) setProjects(rows ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) toast.error(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { projects, loading };
}

// ============================================================
// Tab 1: 自定义统计(§11.3)
// ============================================================

interface CustomSummary {
  currentBudget: string;
  paid: string;
  payable: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
}

interface CustomRecord {
  id: string;
  projectId: string;
  budgetYear: number;
  subjectId: string;
  amount: string;
  businessDate: string;
  enteredAt: string;
  handler: string;
  summary: string;
  status: BusinessStatus;
  isVoid: boolean;
  remark: string | null;
  subject: { id: string; code: string; name: string };
}

interface CustomResult {
  summary: CustomSummary;
  records: CustomRecord[];
}

/** 查询筛选(全部可选;查询按钮落定,避免每次输入都请求)。 */
interface CustomFilters {
  projectId?: string;
  budgetYear?: number;
  /** 科目模糊(名称/编号 contains,跨项目;服务端含非叶展开)。 */
  subject?: string;
  status?: BusinessStatus;
  dateRange?: DateRange;
  handler?: string;
  includeVoid?: boolean;
}

function buildCustomQuery(f: CustomFilters): string {
  const qs = new URLSearchParams();
  if (f.projectId) qs.set('projectId', f.projectId);
  if (f.budgetYear !== undefined) qs.set('budgetYear', String(f.budgetYear));
  if (f.subject?.trim()) qs.set('subject', f.subject.trim());
  if (f.status) qs.set('status', f.status);
  if (f.dateRange?.from) qs.set('businessDateFrom', format(f.dateRange.from, 'yyyy-MM-dd'));
  if (f.dateRange?.to) qs.set('businessDateTo', format(f.dateRange.to, 'yyyy-MM-dd'));
  if (f.handler?.trim()) qs.set('handler', f.handler.trim());
  if (f.includeVoid) qs.set('includeVoid', '1');
  return qs.toString();
}

function CustomStatisticsTab() {
  const { projects, loading: loadingProjects } = useAccessibleProjects();
  const [filters, setFilters] = useState<CustomFilters>({});

  const [result, setResult] = useState<CustomResult | null>(null);
  // 初始即 true:挂载自动查询,避免 mount effect 内同步 setState(react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [hasQueried, setHasQueried] = useState(false);
  const [exporting, setExporting] = useState(false);

  // setLoading(true) 由调用方(事件处理器 / 初始 state)负责,函数内只做异步落值。
  const runQuery = useCallback(async (f: CustomFilters) => {
    try {
      const suffix = buildCustomQuery(f);
      const data = await apiFetch<CustomResult>(
        `/api/statistics/custom${suffix ? `?${suffix}` : ''}`,
      );
      setResult(data);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoading(false);
      setHasQueried(true);
    }
  }, []);

  // 首次挂载查询一次(loading 已为 true)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<CustomResult>('/api/statistics/custom')
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) toast.error(e.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setHasQueried(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleQueryClick = () => {
    setLoading(true);
    void runQuery(filters);
  };

  const handleReset = () => {
    setFilters({});
    setLoading(true);
    void runQuery({});
  };

  /** 用当前筛选作为查询参数导出 xlsx(§10.5),与 /api/statistics/custom 同参。 */
  const handleExport = async () => {
    setExporting(true);
    try {
      const suffix = buildCustomQuery(filters);
      await downloadFile(`/api/statistics/export${suffix ? `?${suffix}` : ''}`, 'statistics.xlsx');
      toast.success('已开始导出');
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const summary = result?.summary;

  const summaryCards: Array<{ label: string; node: React.ReactNode }> = summary
    ? [
        {
          label: '当前预算',
          node: (
            <MoneyText value={summary.currentBudget} riskOnNegative={false} className="text-left" />
          ),
        },
        {
          label: '已支出',
          node: <MoneyText value={summary.paid} riskOnNegative={false} className="text-left" />,
        },
        {
          label: '应付未付',
          node: <MoneyText value={summary.payable} riskOnNegative={false} className="text-left" />,
        },
        {
          label: '总占用',
          node: (
            <MoneyText value={summary.totalOccupied} riskOnNegative={false} className="text-left" />
          ),
        },
        { label: '结余', node: <MoneyText value={summary.balance} className="text-left" /> },
        { label: '执行率', node: renderRate(summary.executionRate) },
      ]
    : [];

  return (
    <div className="space-y-4">
      {/* 查询构建器:标签在上的网格布局,替代 antd 内联挤排 */}
      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="grid gap-1.5">
            <Label>项目</Label>
            <Select
              value={filters.projectId ?? ALL}
              onValueChange={(v) =>
                setFilters((f) => ({ ...f, projectId: v === ALL ? undefined : v }))
              }
              disabled={loadingProjects}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="跨项目(管理员)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>跨项目(管理员)</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>年度</Label>
            <Select
              value={filters.budgetYear !== undefined ? String(filters.budgetYear) : ALL}
              onValueChange={(v) =>
                setFilters((f) => ({ ...f, budgetYear: v === ALL ? undefined : Number(v) }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部年度" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部年度</SelectItem>
                {yearOptions().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>科目</Label>
            <Input
              placeholder="名称/编号模糊匹配,回车查询"
              value={filters.subject ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, subject: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleQueryClick();
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>状态</Label>
            <Select
              value={filters.status ?? ALL}
              onValueChange={(v) =>
                setFilters((f) => ({ ...f, status: v === ALL ? undefined : (v as BusinessStatus) }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部状态</SelectItem>
                {BUSINESS_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>申请日期</Label>
            <DateRangePicker
              value={filters.dateRange}
              onChange={(range) => setFilters((f) => ({ ...f, dateRange: range }))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>经办人</Label>
            <Input
              placeholder="模糊匹配,回车查询"
              value={filters.handler ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, handler: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleQueryClick();
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>作废记录</Label>
            <div className="flex h-8 items-center gap-2">
              <Switch
                checked={filters.includeVoid ?? false}
                onCheckedChange={(checked) =>
                  setFilters((f) => ({ ...f, includeVoid: checked || undefined }))
                }
                aria-label="是否包含作废记录"
              />
              <span className="text-sm text-muted-foreground">
                {filters.includeVoid ? '含作废' : '仅有效'}
              </span>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <Button onClick={handleQueryClick} disabled={loading}>
              <Search />
              {loading ? '查询中…' : '查询'}
            </Button>
            <Button variant="outline" onClick={handleReset} disabled={loading}>
              <RotateCcw />
              重置
            </Button>
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              <Download />
              {exporting ? '导出中…' : '导出'}
            </Button>
          </div>
        </div>
      </Card>

      {summary ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {summaryCards.map((c) => (
            <Card key={c.label} className="p-3">
              <p className="caption-mono">{c.label}</p>
              <p className="mt-1.5 text-lg font-semibold tracking-[-0.4px] tabular-nums">
                {c.node}
              </p>
            </Card>
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-32">科目编码</TableHead>
              <TableHead>科目名称</TableHead>
              <TableHead className="w-20">年度</TableHead>
              <TableHead className="w-32">申请日期</TableHead>
              <TableHead className="w-32 text-right">金额</TableHead>
              <TableHead className="w-32">状态</TableHead>
              <TableHead className="w-28">经办人</TableHead>
              <TableHead>摘要</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i} className="">
                  <TableCell colSpan={8}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : (result?.records.length ?? 0) === 0 ? (
              <TableRow className="">
                <TableCell colSpan={8} className="h-32 text-center text-muted-foreground">
                  {hasQueried ? '没有匹配的业务记录' : '点击"查询"加载明细'}
                </TableCell>
              </TableRow>
            ) : (
              result?.records.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-[13px]">{r.subject?.code ?? '—'}</TableCell>
                  <TableCell className="max-w-48 truncate" title={r.subject?.name}>
                    {r.subject?.name ?? '—'}
                  </TableCell>
                  <TableCell className="tabular-nums">{r.budgetYear}</TableCell>
                  <TableCell className="tabular-nums">{formatDate(r.businessDate)}</TableCell>
                  <TableCell>
                    <MoneyText value={r.amount} riskOnNegative={false} />
                  </TableCell>
                  <TableCell>
                    {r.isVoid ? (
                      <Badge variant="error">已作废</Badge>
                    ) : (
                      <Badge variant={STATUS_BADGE[r.status] ?? 'secondary'}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{r.handler}</TableCell>
                  <TableCell className="max-w-48 truncate" title={r.summary}>
                    {r.summary || <span className="text-mute">—</span>}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {!loading && (result?.records.length ?? 0) > 0 ? (
          <div className="border-t border-border px-4 py-2 text-xs text-mute tabular-nums">
            共 {result?.records.length} 条记录
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ============================================================
// Tab 2: 月度历史(§11.4)
// ============================================================

interface MonthlyBucket {
  month: number;
  paid: string;
  payable: string;
  totalOccupied: string;
}

interface MonthlyResult {
  months: MonthlyBucket[];
}

function MonthlyHistoryTab() {
  const { projects, loading: loadingProjects } = useAccessibleProjects();
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [year, setYear] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<MonthlyResult | null>(null);
  const [loading, setLoading] = useState(false);

  const runQuery = async () => {
    if (!projectId || year === undefined) {
      toast.warning('请选择项目与年度');
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({ projectId, year: String(year) });
      const data = await apiFetch<MonthlyResult>(`/api/statistics/monthly?${qs.toString()}`);
      setResult(data);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid w-64 gap-1.5">
            <Label>项目</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={loadingProjects}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择项目" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid w-32 gap-1.5">
            <Label>年度</Label>
            <Select
              value={year !== undefined ? String(year) : undefined}
              onValueChange={(v) => setYear(Number(v))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择年度" />
              </SelectTrigger>
              <SelectContent>
                {yearOptions().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => void runQuery()} disabled={loading}>
            <Search />
            {loading ? '查询中…' : '查询'}
          </Button>
        </div>
      </Card>

      <Alert variant="info">
        <AlertDescription>按申请日期归月,实时重算;仅统计有效(非作废)记录(§11.4)。</AlertDescription>
      </Alert>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-24">月份</TableHead>
              <TableHead className="text-right">已支出</TableHead>
              <TableHead className="text-right">应付未付</TableHead>
              <TableHead className="text-right">总占用</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i} className="">
                  <TableCell colSpan={4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : (result?.months.length ?? 0) === 0 ? (
              <TableRow className="">
                <TableCell colSpan={4} className="h-32 text-center text-muted-foreground">
                  {result ? '暂无数据' : '选择项目与年度后查询'}
                </TableCell>
              </TableRow>
            ) : (
              result?.months.map((m) => (
                <TableRow key={m.month}>
                  <TableCell className="tabular-nums">{m.month} 月</TableCell>
                  <TableCell>
                    <MoneyText value={m.paid} riskOnNegative={false} />
                  </TableCell>
                  <TableCell>
                    <MoneyText value={m.payable} riskOnNegative={false} />
                  </TableCell>
                  <TableCell>
                    <MoneyText value={m.totalOccupied} riskOnNegative={false} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ============================================================
// Tab 3: 跨项目统计(§11.5) — admin only
// ============================================================

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

function CrossProjectTab() {
  const [result, setResult] = useState<CrossProjectResult | null>(null);
  // 初始即 true(挂载自动查询),避免 mount effect 内同步 setState。
  const [loading, setLoading] = useState(true);
  const [hasQueried, setHasQueried] = useState(false);

  // setLoading(true) 由调用方(初始 state / 事件处理器)负责,函数内只做异步落值。
  const runQuery = useCallback(async () => {
    try {
      const data = await apiFetch<CrossProjectResult>('/api/statistics/cross-project');
      setResult(data);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoading(false);
      setHasQueried(true);
    }
  }, []);

  // 首次挂载自动查询一次(loading 已为 true)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<CrossProjectResult>('/api/statistics/cross-project')
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) toast.error(e.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setHasQueried(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = () => {
    setLoading(true);
    void runQuery();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" onClick={handleRefresh} disabled={loading}>
          <RotateCcw />
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>

      <Alert variant="info">
        <AlertDescription>
          跨项目汇总管理员可见的全部项目(非归档),同名科目不合并(§11.5)。
        </AlertDescription>
      </Alert>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>项目</TableHead>
              <TableHead className="text-right">当前预算</TableHead>
              <TableHead className="text-right">已支出</TableHead>
              <TableHead className="text-right">总占用</TableHead>
              <TableHead className="text-right">结余</TableHead>
              <TableHead className="w-28 text-right">执行率</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i} className="">
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : (result?.projects.length ?? 0) === 0 ? (
              <TableRow className="">
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                  {hasQueried ? '暂无项目' : '点击"刷新"加载'}
                </TableCell>
              </TableRow>
            ) : (
              result?.projects.map((r) => (
                <TableRow key={r.projectId}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <MoneyText value={r.currentBudget} riskOnNegative={false} />
                  </TableCell>
                  <TableCell>
                    <MoneyText value={r.paid} riskOnNegative={false} />
                  </TableCell>
                  <TableCell>
                    <MoneyText value={r.totalOccupied} riskOnNegative={false} />
                  </TableCell>
                  <TableCell>
                    <MoneyText value={r.balance} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {renderRate(r.executionRate)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ============================================================
// Tab 4: 经费余额(总预算口径:科目总预算 − 累计占用)
// ============================================================

interface BalanceRow {
  projectId: string;
  projectCode: string;
  projectName: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  isLeaf: boolean;
  totalBudget: string;
  paid: string;
  payable: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
  yearBudget: string | null;
  yearOccupied: string | null;
  yearBalance: string | null;
}

interface BalanceResult {
  hitProjects: number;
  hitSubjects: number;
  rows: BalanceRow[];
  total: Omit<
    BalanceRow,
    | 'projectId'
    | 'projectCode'
    | 'projectName'
    | 'subjectId'
    | 'subjectCode'
    | 'subjectName'
    | 'isLeaf'
  >;
}

interface BalanceFilters {
  subject?: string;
  projectId?: string;
  year?: number;
  onlyNegative?: boolean;
}

function buildBalanceQuery(f: BalanceFilters): string {
  const qs = new URLSearchParams();
  if (f.subject?.trim()) qs.set('subject', f.subject.trim());
  if (f.projectId) qs.set('projectId', f.projectId);
  if (f.year !== undefined) qs.set('year', String(f.year));
  if (f.onlyNegative) qs.set('onlyNegative', '1');
  return qs.toString();
}

/** 可排序列(金额列按数值比较)。 */
type BalanceSortKey =
  | 'projectName'
  | 'subjectName'
  | 'totalBudget'
  | 'paid'
  | 'payable'
  | 'totalOccupied'
  | 'balance'
  | 'executionRate'
  | 'yearBudget'
  | 'yearOccupied'
  | 'yearBalance';

function compareBalanceRows(key: BalanceSortKey, dir: 'asc' | 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return (a: BalanceRow, b: BalanceRow): number => {
    if (
      key === 'totalBudget' ||
      key === 'paid' ||
      key === 'payable' ||
      key === 'totalOccupied' ||
      key === 'balance' ||
      key === 'yearBudget' ||
      key === 'yearOccupied' ||
      key === 'yearBalance'
    ) {
      return (Number(a[key] ?? '0') - Number(b[key] ?? '0')) * sign;
    }
    if (key === 'executionRate') {
      const av = a.executionRate ?? -Infinity;
      const bv = b.executionRate ?? -Infinity;
      return (av - bv) * sign;
    }
    return String(a[key]).localeCompare(String(b[key]), 'zh-Hans-CN') * sign;
  };
}

/** 排序表头(点击切 asc/desc;模块级组件,状态经 props 注入)。 */
function SortHead({
  sort,
  keyName,
  label,
  align = 'right',
  onToggle,
}: {
  sort: { key: BalanceSortKey; dir: 'asc' | 'desc' };
  keyName: BalanceSortKey;
  label: string;
  align?: 'left' | 'right';
  onToggle: (key: BalanceSortKey) => void;
}) {
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        className="inline-flex items-center gap-0.5 hover:text-foreground"
        onClick={() => onToggle(keyName)}
      >
        {label}
        <span className="text-[10px] text-mute">
          {sort.key === keyName ? (sort.dir === 'asc' ? '▲' : '▼') : '·'}
        </span>
      </button>
    </TableHead>
  );
}

function BalanceTab() {
  const { projects, loading: loadingProjects } = useAccessibleProjects();
  const [filters, setFilters] = useState<BalanceFilters>({});
  const [result, setResult] = useState<BalanceResult | null>(null);
  // 已成功应用的年度:年度三列据此显示(不跟随编辑中的筛选,防止未点查询时列语义漂移)。
  const [appliedYear, setAppliedYear] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  // 默认按总结余升序(最紧张在前)。
  const [sort, setSort] = useState<{ key: BalanceSortKey; dir: 'asc' | 'desc' }>({
    key: 'balance',
    dir: 'asc',
  });

  const runQuery = useCallback(async (f: BalanceFilters) => {
    try {
      const suffix = buildBalanceQuery(f);
      const data = await apiFetch<BalanceResult>(
        `/api/statistics/balance${suffix ? `?${suffix}` : ''}`,
      );
      setResult(data);
      setAppliedYear(f.year);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次挂载查询一次(loading 已为 true)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<BalanceResult>('/api/statistics/balance')
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) toast.error(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleQueryClick = () => {
    setLoading(true);
    void runQuery(filters);
  };

  const handleReset = () => {
    setFilters({});
    setLoading(true);
    void runQuery({});
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const suffix = buildBalanceQuery(filters);
      await downloadFile(
        `/api/statistics/export?mode=balance${suffix ? `&${suffix}` : ''}`,
        'balance-statistics.xlsx',
      );
      toast.success('已开始导出');
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const toggleSort = (key: BalanceSortKey) => {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  const sortedRows = useMemo(
    () => [...(result?.rows ?? [])].sort(compareBalanceRows(sort.key, sort.dir)),
    [result, sort],
  );

  // 年度三列:跟随已应用的查询(而非编辑中的筛选),与 result 数据语义一致。
  const hasYear = appliedYear !== undefined;
  const t = result?.total;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="grid gap-1.5">
            <Label>科目</Label>
            <Input
              placeholder="名称/编号模糊匹配,如 劳务 / LWF"
              value={filters.subject ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, subject: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleQueryClick();
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>项目</Label>
            <Select
              value={filters.projectId ?? ALL}
              onValueChange={(v) =>
                setFilters((f) => ({ ...f, projectId: v === ALL ? undefined : v }))
              }
              disabled={loadingProjects}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部项目" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部项目</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>年度(加显年度口径列)</Label>
            <Select
              value={filters.year !== undefined ? String(filters.year) : ALL}
              onValueChange={(v) =>
                setFilters((f) => ({ ...f, year: v === ALL ? undefined : Number(v) }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="不按年度" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>不按年度</SelectItem>
                {yearOptions().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>仅看结余为负</Label>
            <div className="flex h-8 items-center gap-2">
              <Switch
                checked={filters.onlyNegative ?? false}
                onCheckedChange={(checked) =>
                  setFilters((f) => ({ ...f, onlyNegative: checked || undefined }))
                }
                aria-label="仅看总结余为负的科目"
              />
              <span className="text-sm text-muted-foreground">
                {filters.onlyNegative ? '仅负结余' : '全部'}
              </span>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <Button onClick={handleQueryClick} disabled={loading}>
              <Search />
              {loading ? '查询中…' : '查询'}
            </Button>
            <Button variant="outline" onClick={handleReset} disabled={loading}>
              <RotateCcw />
              重置
            </Button>
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              <Download />
              {exporting ? '导出中…' : '导出'}
            </Button>
          </div>
        </div>
        {result ? (
          <p className="mt-3 text-xs text-mute tabular-nums">
            命中 {result.hitProjects} 个项目 × {result.hitSubjects} 个科目;结余口径 =
            科目总预算(含调整) − 累计占用
          </p>
        ) : null}
      </Card>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortHead
                sort={sort}
                onToggle={toggleSort}
                keyName="projectName"
                label="项目"
                align="left"
              />
              <SortHead
                sort={sort}
                onToggle={toggleSort}
                keyName="subjectName"
                label="科目"
                align="left"
              />
              <SortHead
                sort={sort}
                onToggle={toggleSort}
                keyName="totalBudget"
                label="科目总预算"
              />
              <SortHead sort={sort} onToggle={toggleSort} keyName="paid" label="已支出" />
              <SortHead sort={sort} onToggle={toggleSort} keyName="payable" label="应付未付" />
              <SortHead sort={sort} onToggle={toggleSort} keyName="totalOccupied" label="总占用" />
              <SortHead sort={sort} onToggle={toggleSort} keyName="balance" label="总结余" />
              <SortHead sort={sort} onToggle={toggleSort} keyName="executionRate" label="执行率" />
              {hasYear ? (
                <>
                  <SortHead
                    sort={sort}
                    onToggle={toggleSort}
                    keyName="yearBudget"
                    label="年度预算"
                  />
                  <SortHead
                    sort={sort}
                    onToggle={toggleSort}
                    keyName="yearOccupied"
                    label="年度占用"
                  />
                  <SortHead
                    sort={sort}
                    onToggle={toggleSort}
                    keyName="yearBalance"
                    label="年度结余"
                  />
                </>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i} className="">
                  <TableCell colSpan={hasYear ? 11 : 8}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : sortedRows.length === 0 ? (
              <TableRow className="">
                <TableCell
                  colSpan={hasYear ? 11 : 8}
                  className="h-32 text-center text-muted-foreground"
                >
                  没有匹配的科目
                </TableCell>
              </TableRow>
            ) : (
              sortedRows.map((row) => (
                <TableRow key={`${row.projectId}|${row.subjectId}`}>
                  <TableCell
                    className="max-w-40 truncate"
                    title={`${row.projectCode} ${row.projectName}`}
                  >
                    {row.projectCode} {row.projectName}
                  </TableCell>
                  <TableCell
                    className="max-w-48 truncate"
                    title={`${row.subjectCode} ${row.subjectName}`}
                  >
                    <span className="font-mono text-[13px] text-mute">{row.subjectCode}</span>{' '}
                    {row.subjectName}
                    {!row.isLeaf ? <span className="ml-1 text-xs text-mute">(含下级)</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.totalBudget}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.paid}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.payable}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.totalOccupied}</TableCell>
                  <TableCell>
                    <MoneyText value={row.balance} className="block text-right" />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {renderRate(row.executionRate)}
                  </TableCell>
                  {hasYear ? (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {row.yearBudget ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.yearOccupied ?? '—'}
                      </TableCell>
                      <TableCell>
                        <MoneyText value={row.yearBalance ?? '0.00'} className="block text-right" />
                      </TableCell>
                    </>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
          {!loading && t && sortedRows.length > 0 ? (
            <TableFooter>
              <TableRow className="font-semibold">
                <TableCell colSpan={2}>合计(命中科目去重)</TableCell>
                <TableCell className="text-right tabular-nums">{t.totalBudget}</TableCell>
                <TableCell className="text-right tabular-nums">{t.paid}</TableCell>
                <TableCell className="text-right tabular-nums">{t.payable}</TableCell>
                <TableCell className="text-right tabular-nums">{t.totalOccupied}</TableCell>
                <TableCell>
                  <MoneyText value={t.balance} className="block text-right" />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {renderRate(t.executionRate)}
                </TableCell>
                {hasYear ? (
                  <>
                    <TableCell className="text-right tabular-nums">{t.yearBudget ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {t.yearOccupied ?? '—'}
                    </TableCell>
                    <TableCell>
                      <MoneyText value={t.yearBalance ?? '0.00'} className="block text-right" />
                    </TableCell>
                  </>
                ) : null}
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>
    </div>
  );
}
