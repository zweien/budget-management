'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { Download, Paperclip, RotateCcw, Search } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { DateRange } from 'react-day-picker';

import { apiFetch, downloadFile } from '@/lib/api/client';
import { PageHeader } from '@/components/layout/page-header';
import { AttachmentSheet } from '@/components/records/AttachmentSheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  ColumnSettingsPopover,
  useStoredColumnVisibility,
  type ColumnSettingItem,
} from '@/components/ui/column-settings';
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
import { TableEmpty, TablePagination } from '@/components/ui/table-pagination';
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
  completedDate: string | null;
  enteredAt: string;
  handler: string;
  summary: string;
  status: BusinessStatus;
  isVoid: boolean;
  docNo: string | null;
  remark: string | null;
  subject: { id: string; code: string; name: string };
  project: { id: string; code: string; name: string };
  creatorName: string | null;
  attachmentCount: number;
}

interface CustomStats {
  totalCount: number;
  validCount: number;
  amountSum: string;
}

interface CustomResult {
  summary: CustomSummary;
  records: CustomRecord[];
  total: number;
  stats: CustomStats;
}

/** 明细列集(与业务录入页对齐,PR #51 统一口径;列设置弹层同款)。 */
const RECORD_COLUMNS: ColumnSettingItem[] = [
  { id: 'project', label: '项目' },
  { id: 'budgetYear', label: '年度' },
  { id: 'subject', label: '科目' },
  { id: 'amount', label: '金额' },
  { id: 'businessDate', label: '申请日期' },
  { id: 'completedDate', label: '完成日期' },
  { id: 'status', label: '状态' },
  { id: 'handler', label: '经办人' },
  { id: 'docNo', label: '单据编号' },
  { id: 'summary', label: '摘要' },
  { id: 'remark', label: '备注' },
  { id: 'enteredAt', label: '录入时间' },
  { id: 'creatorName', label: '录入人' },
  { id: 'attachments', label: '附件' },
];

/** 分页条可选项(与业务录入页一致)。 */
const PAGE_SIZES = [50, 100, 200];

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

  // 服务端分页(§11.3 接口已支持 page/pageSize,total 为筛选全集行数)。
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  // 已应用的筛选快照:翻页/每页条数/导出都用它,与当前展示结果同源
  // (codex P2:直接用草稿 filters 会在改完条件未点查询时翻页漂移到另一组数据的第 N 页)。
  const [appliedFilters, setAppliedFilters] = useState<CustomFilters>({});
  // 请求序号:仅最新请求可落结果(codex P2:慢的旧响应不得覆盖新结果)。
  const reqSeqRef = useRef(0);

  // 列显隐偏好(localStorage 持久化,与录入页/项目列表页同款交互)。
  const [columnVisibility, toggleColumn] = useStoredColumnVisibility('ui.statistics.columns');
  const colVisible = (id: string) => columnVisibility[id] !== false;
  const visibleColumnCount = RECORD_COLUMNS.filter((c) => colVisible(c.id)).length;

  // 附件抽屉目标(跨项目:按行打开;统计页定位是只读分析,不可写)。
  const [attachmentTarget, setAttachmentTarget] = useState<{
    id: string;
    projectId: string;
    summary: string;
    handler: string;
    amount: string;
    businessDate: string;
    isVoid: boolean;
  } | null>(null);

  // setLoading(true) 由调用方(事件处理器 / 初始 state)负责,函数内只做异步落值。
  const runQuery = useCallback(async (f: CustomFilters, p: number, ps: number) => {
    const seq = ++reqSeqRef.current;
    try {
      const qs = new URLSearchParams(buildCustomQuery(f));
      qs.set('page', String(p));
      qs.set('pageSize', String(ps));
      const data = await apiFetch<CustomResult>(`/api/statistics/custom?${qs.toString()}`);
      if (seq === reqSeqRef.current) setResult(data);
    } catch (e) {
      if (seq === reqSeqRef.current && e instanceof Error) toast.error(e.message);
    } finally {
      if (seq === reqSeqRef.current) {
        setLoading(false);
        setHasQueried(true);
      }
    }
  }, []);

  // 首次挂载查询一次(loading 已为 true);同一序号守卫,防慢响应被后续查询乱序覆盖。
  useEffect(() => {
    const seq = ++reqSeqRef.current;
    let cancelled = false;
    apiFetch<CustomResult>('/api/statistics/custom?page=1&pageSize=50')
      .then((data) => {
        if (!cancelled && seq === reqSeqRef.current) setResult(data);
      })
      .catch((e: unknown) => {
        if (!cancelled && seq === reqSeqRef.current && e instanceof Error) toast.error(e.message);
      })
      .finally(() => {
        if (!cancelled && seq === reqSeqRef.current) {
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
    setPage(1);
    setAppliedFilters(filters);
    void runQuery(filters, 1, pageSize);
  };

  const handleReset = () => {
    setFilters({});
    setAppliedFilters({});
    setLoading(true);
    setPage(1);
    void runQuery({}, 1, pageSize);
  };

  /** 翻页/改每页条数:沿用已应用的筛选快照(与展示结果同源)。 */
  const goToPage = (p: number) => {
    setLoading(true);
    setPage(p);
    void runQuery(appliedFilters, p, pageSize);
  };

  const changePageSize = (ps: number) => {
    setLoading(true);
    setPageSize(ps);
    setPage(1);
    void runQuery(appliedFilters, 1, ps);
  };

  /** 用已应用筛选导出 xlsx(§10.5,所见即所导);不带分页参数,导出筛选全集。
   *  附带浏览器时区偏移:导出的「录入时间」按用户时区渲染,与页面一致(codex P2)。 */
  const handleExport = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams(buildCustomQuery(appliedFilters));
      qs.set('tzOffset', String(new Date().getTimezoneOffset()));
      await downloadFile(`/api/statistics/export?${qs.toString()}`, 'statistics.xlsx');
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
                    {p.name}
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
            <ColumnSettingsPopover
              items={RECORD_COLUMNS}
              columnVisibility={columnVisibility}
              onToggle={toggleColumn}
            />
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
              {colVisible('project') ? <TableHead>项目</TableHead> : null}
              {colVisible('budgetYear') ? <TableHead className="w-20">年度</TableHead> : null}
              {colVisible('subject') ? <TableHead>科目</TableHead> : null}
              {colVisible('amount') ? (
                <TableHead className="w-32 text-right">金额</TableHead>
              ) : null}
              {colVisible('businessDate') ? <TableHead className="w-28">申请日期</TableHead> : null}
              {colVisible('completedDate') ? (
                <TableHead className="w-28">完成日期</TableHead>
              ) : null}
              {colVisible('status') ? <TableHead className="w-32">状态</TableHead> : null}
              {colVisible('handler') ? <TableHead className="w-24">经办人</TableHead> : null}
              {colVisible('docNo') ? <TableHead className="w-32">单据编号</TableHead> : null}
              {colVisible('summary') ? <TableHead className="max-w-40">摘要</TableHead> : null}
              {colVisible('remark') ? <TableHead className="max-w-32">备注</TableHead> : null}
              {colVisible('enteredAt') ? <TableHead className="w-36">录入时间</TableHead> : null}
              {colVisible('creatorName') ? <TableHead className="w-24">录入人</TableHead> : null}
              {colVisible('attachments') ? <TableHead className="w-16">附件</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i} className="">
                  <TableCell colSpan={visibleColumnCount}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : (result?.records.length ?? 0) === 0 ? (
              <TableEmpty colSpan={visibleColumnCount}>
                {hasQueried ? '没有匹配的业务记录' : '点击"查询"加载明细'}
              </TableEmpty>
            ) : (
              result?.records.map((r) => (
                <TableRow key={r.id}>
                  {colVisible('project') ? (
                    <TableCell>
                      <Link
                        href={`/projects/${r.projectId}/records`}
                        className="text-link underline-offset-4 hover:underline"
                      >
                        <span className="block max-w-44 truncate" title={r.project?.name}>
                          {r.project?.name ?? '—'}
                        </span>
                      </Link>
                    </TableCell>
                  ) : null}
                  {colVisible('budgetYear') ? (
                    <TableCell className="tabular-nums">{r.budgetYear}</TableCell>
                  ) : null}
                  {colVisible('subject') ? (
                    <TableCell className="max-w-48 truncate" title={r.subject?.name}>
                      {r.subject?.name ?? '—'}
                    </TableCell>
                  ) : null}
                  {colVisible('amount') ? (
                    <TableCell>
                      <MoneyText value={r.amount} riskOnNegative={false} />
                    </TableCell>
                  ) : null}
                  {colVisible('businessDate') ? (
                    <TableCell className="tabular-nums">{formatDate(r.businessDate)}</TableCell>
                  ) : null}
                  {colVisible('completedDate') ? (
                    <TableCell className="tabular-nums">{formatDate(r.completedDate)}</TableCell>
                  ) : null}
                  {colVisible('status') ? (
                    <TableCell>
                      {r.isVoid ? (
                        <Badge variant="error">已作废</Badge>
                      ) : (
                        <Badge variant={STATUS_BADGE[r.status] ?? 'secondary'}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </Badge>
                      )}
                    </TableCell>
                  ) : null}
                  {colVisible('handler') ? <TableCell>{r.handler}</TableCell> : null}
                  {colVisible('docNo') ? (
                    <TableCell>
                      <span
                        className="block max-w-32 truncate font-mono text-xs"
                        title={r.docNo ?? undefined}
                      >
                        {r.docNo || '—'}
                      </span>
                    </TableCell>
                  ) : null}
                  {colVisible('summary') ? (
                    <TableCell className="max-w-40 truncate" title={r.summary}>
                      {r.summary || <span className="text-mute">—</span>}
                    </TableCell>
                  ) : null}
                  {colVisible('remark') ? (
                    <TableCell>
                      {r.remark ? (
                        <span
                          className="block max-w-32 truncate text-muted-foreground"
                          title={r.remark}
                        >
                          {r.remark}
                        </span>
                      ) : (
                        <span className="text-mute">—</span>
                      )}
                    </TableCell>
                  ) : null}
                  {colVisible('enteredAt') ? (
                    <TableCell className="tabular-nums">
                      {r.enteredAt ? format(new Date(r.enteredAt), 'yyyy-MM-dd HH:mm') : '—'}
                    </TableCell>
                  ) : null}
                  {colVisible('creatorName') ? <TableCell>{r.creatorName ?? '—'}</TableCell> : null}
                  {colVisible('attachments') ? (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-mute"
                        onClick={() =>
                          setAttachmentTarget({
                            id: r.id,
                            projectId: r.projectId,
                            summary: r.summary,
                            handler: r.handler,
                            amount: r.amount,
                            businessDate: r.businessDate,
                            isVoid: r.isVoid,
                          })
                        }
                        aria-label={`查看报销凭证:${r.summary}`}
                      >
                        <Paperclip className="size-4" />
                        {r.attachmentCount > 0 ? (
                          <span className="tabular-nums">{r.attachmentCount}</span>
                        ) : null}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {!loading && result && result.records.length > 0 ? (
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            loading={loading}
            onPageChange={goToPage}
            onPageSizeChange={changePageSize}
            pageSizes={PAGE_SIZES}
            leftHint={
              <span className="flex items-center gap-1">
                共 {result.total} 条 · 有效 {result.stats.validCount} 条 · 金额合计
                <MoneyText
                  value={result.stats.amountSum}
                  riskOnNegative={false}
                  className="inline text-left"
                />
              </span>
            }
          />
        ) : null}
      </div>

      {/* 报销凭证附件抽屉(跨项目按行打开;统计页只读,不可上传) */}
      <AttachmentSheet
        projectId={attachmentTarget?.projectId ?? ''}
        record={attachmentTarget}
        canWrite={false}
        open={attachmentTarget !== null}
        onOpenChange={(open) => {
          if (!open) setAttachmentTarget(null);
        }}
      />
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
                    {p.name}
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
              <TableEmpty colSpan={4}>{result ? '暂无数据' : '选择项目与年度后查询'}</TableEmpty>
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
              <TableEmpty colSpan={6}>{hasQueried ? '暂无项目' : '点击"刷新"加载'}</TableEmpty>
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
                    {p.name}
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
              <TableEmpty colSpan={hasYear ? 11 : 8}>没有匹配的科目</TableEmpty>
            ) : (
              sortedRows.map((row) => (
                <TableRow key={`${row.projectId}|${row.subjectId}`}>
                  <TableCell className="max-w-40 truncate">{row.projectName}</TableCell>
                  <TableCell className="max-w-48 truncate">
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
