'use client';

import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { ChevronDown, ChevronLeft, ChevronRight, RotateCcw, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { DateRange } from 'react-day-picker';

import { apiFetch } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface OperatorRef {
  id: string;
  name: string;
}

interface AuditLogRow {
  id: string;
  projectId: string | null;
  objectType: string;
  objectId: string;
  action: string;
  beforeData: unknown;
  afterData: unknown;
  operatorId: string;
  operatedAt: string;
  operator: OperatorRef;
}

interface AuditLogResponse {
  logs: AuditLogRow[];
  total: number;
}

interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

interface UserOption {
  id: string;
  name: string;
  role: string;
}

interface FilterValues {
  projectId?: string;
  objectType?: string;
  action?: string;
  operatorId?: string;
  dateRange?: DateRange;
}

/** §14.1 已知对象类型(与 server recordAudit 调用点保持一致)。 */
const OBJECT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'project', label: '项目' },
  { value: 'initial_budget_applications', label: '初始预算编制' },
  { value: 'budget_adjustments', label: '预算调整' },
  { value: 'subject_change_applications', label: '科目变更' },
  { value: 'business_records', label: '业务记录' },
  { value: 'receipt_records', label: '到账流水' },
];

/** §14.1 已知动作类型(与 server recordAudit 调用点保持一致)。 */
const ACTION_OPTIONS: { value: string; label: string }[] = [
  { value: 'create', label: '新建' },
  { value: 'update', label: '修改' },
  { value: 'delete', label: '删除' },
  { value: 'submit', label: '提交' },
  { value: 'approve', label: '审批通过' },
  { value: 'reject', label: '驳回' },
  { value: 'withdraw', label: '撤回' },
  { value: 'archive', label: '归档' },
  { value: 'void', label: '作废' },
  { value: 'status_switch', label: '状态切换' },
  { value: 'import', label: '导入' },
  { value: 'carryover', label: '跨年结转' },
];

/** Select 的"全部"哨兵值(radix SelectItem 不允许空串)。 */
const ALL = '__all__';

const formatDateTime = (s: string | null): string => {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm:ss');
};

/** 把任意 JSON 值渲染为缩进 JSON 文本(null/空 → 占位)。 */
function renderJson(v: unknown): string {
  if (v === null || v === undefined) return '—';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  // 初始即 true:挂载自动查询,避免 mount effect 内同步 setState。
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);

  // 草稿筛选(表单中编辑)+ 活跃筛选(查询后落定,分页沿用)。
  const [draftFilters, setDraftFilters] = useState<FilterValues>({});
  const [activeFilters, setActiveFilters] = useState<FilterValues>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 拉取项目 + 用户下拉(admin:全部项目;非 admin:可访问项目)。
  useEffect(() => {
    let cancelled = false;
    Promise.all([apiFetch<ProjectOption[]>('/api/projects'), apiFetch<UserOption[]>('/api/users')])
      .then(([p, u]) => {
        if (cancelled) return;
        setProjects(p ?? []);
        setUsers(u ?? []);
      })
      .catch((e: unknown) => {
        // 下拉失败不致命(可空着筛选);仅提示。
        if (!cancelled && e instanceof Error) toast.warning(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const buildQuery = useCallback((filters: FilterValues, p: number, size: number): string => {
    const qs = new URLSearchParams();
    if (filters.projectId) qs.set('projectId', filters.projectId);
    if (filters.objectType) qs.set('objectType', filters.objectType);
    if (filters.action) qs.set('action', filters.action);
    if (filters.operatorId) qs.set('operatorId', filters.operatorId);
    if (filters.dateRange?.from) qs.set('dateFrom', format(filters.dateRange.from, 'yyyy-MM-dd'));
    if (filters.dateRange?.to) qs.set('dateTo', format(filters.dateRange.to, 'yyyy-MM-dd'));
    qs.set('limit', String(size));
    qs.set('offset', String((p - 1) * size));
    return `/api/audit-logs?${qs.toString()}`;
  }, []);

  // setLoading 由调用方(初始 state / 事件处理器)负责,函数内只做异步落值。
  const runQuery = useCallback(
    async (filters: FilterValues, p: number, size: number) => {
      setFatal(null);
      try {
        const data = await apiFetch<AuditLogResponse>(buildQuery(filters, p, size));
        setLogs(data.logs);
        setTotal(data.total);
      } catch (e) {
        const err = e as Error & { status?: number };
        if (err.status === 403) {
          setFatal('无权访问操作日志');
        } else {
          setFatal(err.message || '加载操作日志失败');
        }
      } finally {
        setLoading(false);
      }
    },
    [buildQuery],
  );

  // 首次挂载查询一次(loading 已为 true)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<AuditLogResponse>(buildQuery({}, 1, 20))
      .then((data) => {
        if (!cancelled) {
          setLogs(data.logs);
          setTotal(data.total);
        }
      })
      .catch((e: unknown) => {
        const err = e as Error & { status?: number };
        if (!cancelled) {
          setFatal(err.status === 403 ? '无权访问操作日志' : err.message || '加载操作日志失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buildQuery]);

  const handleQueryClick = () => {
    setActiveFilters(draftFilters);
    setPage(1);
    setLoading(true);
    void runQuery(draftFilters, 1, pageSize);
  };

  const handleReset = () => {
    setDraftFilters({});
    setActiveFilters({});
    setPage(1);
    setLoading(true);
    void runQuery({}, 1, pageSize);
  };

  const goToPage = (nextPage: number, nextSize = pageSize) => {
    setPage(nextPage);
    setPageSize(nextSize);
    setLoading(true);
    void runQuery(activeFilters, nextPage, nextSize);
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (fatal) {
    return (
      <div className="space-y-4">
        <Alert variant="error">
          <AlertDescription>{fatal}</AlertDescription>
        </Alert>
        <Button
          variant="outline"
          onClick={() => {
            setLoading(true);
            void runQuery(activeFilters, page, pageSize);
          }}
        >
          重试
        </Button>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const filterSelect = (
    label: string,
    key: 'projectId' | 'objectType' | 'action' | 'operatorId',
    options: { value: string; label: string }[],
    placeholder: string,
  ) => (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Select
        value={draftFilters[key] ?? ALL}
        onValueChange={(v) => setDraftFilters((f) => ({ ...f, [key]: v === ALL ? undefined : v }))}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{placeholder}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Audit Logs"
        title="操作日志"
        description="审计日志(§14.1):对象类型/对象编号/动作/操作人/时间;展开行查看前后值。"
      />

      {/* 筛选:标签在上的网格卡片 */}
      <Card className="p-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {filterSelect(
            '项目',
            'projectId',
            projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
            '全部项目',
          )}
          {filterSelect('对象类型', 'objectType', OBJECT_TYPE_OPTIONS, '全部类型')}
          {filterSelect('动作', 'action', ACTION_OPTIONS, '全部动作')}
          {filterSelect(
            '操作人',
            'operatorId',
            users.map((u) => ({ value: u.id, label: u.name })),
            '全部操作人',
          )}
          <div className="grid gap-1.5">
            <Label>时间范围</Label>
            <DateRangePicker
              value={draftFilters.dateRange}
              onChange={(range) => setDraftFilters((f) => ({ ...f, dateRange: range }))}
            />
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Button onClick={handleQueryClick} disabled={loading}>
            <Search />
            {loading ? '查询中…' : '查询'}
          </Button>
          <Button variant="outline" onClick={handleReset} disabled={loading}>
            <RotateCcw />
            重置
          </Button>
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10" />
              <TableHead className="w-36">对象类型</TableHead>
              <TableHead className="w-48">对象编号</TableHead>
              <TableHead className="w-28">动作</TableHead>
              <TableHead className="w-32">操作人</TableHead>
              <TableHead className="w-44">时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={6}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : logs.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                  暂无操作日志
                </TableCell>
              </TableRow>
            ) : (
              logs.map((r) => {
                const expandable = r.beforeData !== null || r.afterData !== null;
                const isOpen = expanded.has(r.id);
                return [
                  <TableRow
                    key={r.id}
                    data-state={isOpen ? 'selected' : undefined}
                    className={cn(expandable && 'cursor-pointer')}
                    onClick={() => expandable && toggleExpand(r.id)}
                  >
                    <TableCell className="w-10 pr-0">
                      {expandable ? (
                        <ChevronDown
                          className={cn(
                            'size-4 text-mute transition-transform',
                            isOpen && 'rotate-180',
                          )}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {OBJECT_TYPE_OPTIONS.find((o) => o.value === r.objectType)?.label ??
                          r.objectType}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.objectId.slice(0, 13)}
                    </TableCell>
                    <TableCell>
                      {ACTION_OPTIONS.find((o) => o.value === r.action)?.label ?? r.action}
                    </TableCell>
                    <TableCell>{r.operator?.name ?? r.operatorId.slice(0, 8)}</TableCell>
                    <TableCell className="tabular-nums">{formatDateTime(r.operatedAt)}</TableCell>
                  </TableRow>,
                  isOpen ? (
                    <TableRow key={`${r.id}-detail`} className="hover:bg-transparent">
                      <TableCell colSpan={6} className="bg-muted/40 p-4">
                        <div className="grid gap-3 lg:grid-cols-2">
                          <div>
                            <p className="caption-mono mb-1.5">变更前 beforeData</p>
                            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs whitespace-pre-wrap">
                              {renderJson(r.beforeData)}
                            </pre>
                          </div>
                          <div>
                            <p className="caption-mono mb-1.5">变更后 afterData</p>
                            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-xs whitespace-pre-wrap">
                              {renderJson(r.afterData)}
                            </pre>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null,
                ];
              })
            )}
          </TableBody>
        </Table>

        {/* 服务端分页 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
          <span className="text-xs text-mute tabular-nums">共 {total} 条</span>
          <div className="flex items-center gap-2">
            <Select value={String(pageSize)} onValueChange={(v) => goToPage(1, Number(v))}>
              <SelectTrigger size="sm" aria-label="每页条数">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 20, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} 条/页
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground tabular-nums">
              {page} / {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              aria-label="上一页"
              disabled={loading || page <= 1}
              onClick={() => goToPage(page - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              aria-label="下一页"
              disabled={loading || page >= totalPages}
              onClick={() => goToPage(page + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
