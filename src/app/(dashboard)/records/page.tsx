'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ClipboardPlus, Download, Funnel, History } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';

import { apiFetch } from '@/lib/api/client';
import { HeaderFilter } from '@/components/ui/data-table-filter';
import { ActiveFilterChips } from '@/components/ui/active-filter-chips';
import type { DateRangeFilterValue } from '@/lib/table/filter-fns';
import { describeDateRangeValue, exportRecordsToXlsx } from '@/lib/table/export-records-xlsx';
import { useUrlSyncedTableState } from '@/lib/table/use-url-table-state';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AmountInput } from '@/components/ui/AmountInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyText } from '@/components/ui/MoneyText';
import { PageHeader } from '@/components/layout/page-header';
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

// ============================================================
// 类型与常量
// ============================================================

/** /api/me/projects 返回(含当前用户权限标记)。 */
interface ProjectWithPermissions {
  id: string;
  code: string;
  name: string;
  canEdit: boolean;
  canWriteRecords: boolean;
}

interface SubjectNode {
  id: string;
  code: string;
  name: string;
  isLeaf: boolean;
}

/** /api/statistics/custom 的记录行(带科目与项目 id)。 */
interface UnifiedRecordRow {
  id: string;
  projectId: string;
  budgetYear: number;
  subjectId: string;
  amount: string;
  businessDate: string;
  completedDate: string | null;
  status: BusinessStatus;
  handler: string;
  summary: string;
  remark: string | null;
  docNo: string | null;
  creatorName: string | null;
  isVoid: boolean;
  createdAt: string;
  subject: { id: string; code: string; name: string } | null;
}

const BUSINESS_STATUSES = ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID'] as const;
type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

const STATUS_LABEL: Record<string, string> = {
  PLACEHOLDER: '登记占位',
  CONTRACT: '合同签订',
  FINANCE_APPROVAL: '财务系统审批',
  PAID: '已支出',
};

const STATUS_BADGE: Record<string, 'secondary' | 'warning' | 'success' | 'outline'> = {
  PLACEHOLDER: 'secondary',
  CONTRACT: 'warning',
  FINANCE_APPROVAL: 'outline',
  PAID: 'success',
};

/** 状态筛选清单的展示映射(含作废哨兵)。 */
const STATUS_FILTER_LABELS: Record<string, string> = {
  PLACEHOLDER: '登记占位',
  CONTRACT: '合同签订',
  FINANCE_APPROVAL: '财务系统审批',
  PAID: '已支出',
  __void__: '已作废',
};

/** 录入/编辑表单(schema 与项目内记录页一致)。 */
const recordSchema = z.object({
  budgetYear: z.coerce.number().int('年度须为整数').min(1900).max(9999),
  subjectId: z.string().min(1, '请选择科目'),
  amount: z
    .string()
    .min(1, '请输入金额')
    .refine((v) => Number(v) > 0, '金额必须大于 0'),
  businessDate: z.date({ message: '请选择申请日期' }),
  status: z.enum(BUSINESS_STATUSES, { message: '请选择状态' }),
  handler: z.string().trim().min(1, '请输入经办人'),
  summary: z.string().trim().min(1, '请输入摘要'),
  remark: z.string().trim(),
});
type RecordFormValues = z.infer<typeof recordSchema>;

// ============================================================
// 页面
// ============================================================

/**
 * 统一业务录入(/records):跨项目的录入 + 管理一体页。
 * - 录入卡片:项目(可录入)→ 叶科目联动 → 表单,支持连续录入。
 * - 记录列表:默认"我可录入的项目",可切全部(只读);行内修改/作废(可写项目)。
 * 权限真相源在服务端(record:create/edit/void 二次校验),此处仅做门控。
 */
function UnifiedRecordsPageInner() {
  // ---- 元数据 ----
  const [projects, setProjects] = useState<ProjectWithPermissions[] | null>(null);
  const [subjectsByProject, setSubjectsByProject] = useState<Record<string, SubjectNode[]>>({});

  // ---- 录入卡片 ----
  const [entryProjectId, setEntryProjectId] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // ---- 列表 ----
  const [scope, setScope] = useState<'writable' | 'all'>('writable');
  const [records, setRecords] = useState<UnifiedRecordRow[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  // 服务端分页/合计(筛选在 SQL 侧,页面只渲染)。
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<{
    totalCount: number;
    validCount: number;
    amountSum: string;
  } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  // 值列稳定候选(独立接口,不随页内数据漂移)。
  const [facets, setFacets] = useState<{
    years: number[];
    handlerNames: string[];
    creatorNames: string[];
    subjectNames: string[];
  } | null>(null);
  // Excel 式表头筛选 + 排序,状态同步到 URL(与项目记录页同一 hook)。
  // 初始值:URL `f` 优先;否则状态默认排除已作废(与项目页口径一致)+ 申请日期降序。
  const { columnFilters, sorting, setColumnFilters, setSorting } = useUrlSyncedTableState({
    columnFilters: [
      { id: 'status', value: ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID'] },
    ],
    sorting: [{ id: 'businessDate', desc: true }],
  });

  // ---- 编辑/作废 ----
  const [editing, setEditing] = useState<UnifiedRecordRow | null>(null);
  const [voidTarget, setVoidTarget] = useState<UnifiedRecordRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidError, setVoidError] = useState<string | null>(null);

  const writableProjects = useMemo(
    () => (projects ?? []).filter((p) => p.canWriteRecords),
    [projects],
  );
  const writableIds = useMemo(() => new Set(writableProjects.map((p) => p.id)), [writableProjects]);
  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects ?? []) m.set(p.id, `${p.code} ${p.name}`);
    return m;
  }, [projects]);

  const entryForm = useForm<RecordFormValues>({
    resolver: zodResolver(recordSchema),
    defaultValues: {
      budgetYear: new Date().getFullYear(),
      subjectId: '',
      amount: '',
      businessDate: new Date(),
      status: 'PLACEHOLDER',
      handler: '',
      summary: '',
      remark: '',
    },
  });
  const editForm = useForm<RecordFormValues>({ resolver: zodResolver(recordSchema) });

  /** 拉取某项目科目树并缓存(叶科目供表单选择)。 */
  const ensureSubjects = useCallback(
    async (projectId: string) => {
      if (subjectsByProject[projectId]) return;
      try {
        const data = await apiFetch<{ subjects: SubjectNode[] }>(
          `/api/projects/${projectId}/subjects`,
        );
        setSubjectsByProject((prev) => ({ ...prev, [projectId]: data.subjects ?? [] }));
      } catch (e) {
        if (e instanceof Error) toast.error(e.message);
      }
    },
    [subjectsByProject],
  );

  // 初始:项目列表(带权限)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectWithPermissions[]>('/api/me/projects')
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) toast.error(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 列 id(表头筛选)→ 服务端查询参数(筛选/排序语义全部下推 SQL)。 */
  const idByLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, label] of projectName) m.set(label, id);
    return m;
  }, [projectName]);

  const buildParams = useCallback(
    (targetPage: number, targetPageSize: number) => {
      const sp = new URLSearchParams();
      const projectIds: string[] = [];
      for (const f of columnFilters) {
        const v = f.value as unknown;
        switch (f.id) {
          case 'project': {
            for (const label of v as string[]) {
              const id = idByLabel.get(label);
              if (id) projectIds.push(id);
            }
            break;
          }
          case 'budgetYear':
            for (const y of v as number[]) sp.append('budgetYears', String(y));
            break;
          case 'subject':
            for (const n of v as string[]) sp.append('subjectNames', n);
            break;
          case 'status': {
            // 勾选 __void__ = 作废可见:statuses + includeVoid(OR isVoid);
            // 仅勾 __void__ = voidOnly。不勾任何 = 默认排除作废(服务端 isVoid=false)。
            const arr = v as string[];
            const statuses = arr.filter((st) => st !== '__void__');
            const hasVoid = arr.length !== statuses.length;
            for (const st of statuses) sp.append('statuses', st);
            if (hasVoid) sp.set('includeVoid', '1');
            if (statuses.length === 0 && hasVoid) sp.set('voidOnly', '1');
            break;
          }
          case 'handler':
            for (const h of v as string[]) sp.append('handlers', h);
            break;
          case 'summary':
            sp.set('summary', String(v));
            break;
          case 'remark':
            sp.set('remark', String(v));
            break;
          case 'amount': {
            const r = v as { min?: string; max?: string };
            if (r.min) sp.set('amountFrom', r.min);
            if (r.max) sp.set('amountTo', r.max);
            break;
          }
          case 'businessDate': {
            const r = v as DateRangeFilterValue;
            if (r.from) sp.set('businessDateFrom', format(new Date(r.from), 'yyyy-MM-dd'));
            if (r.to) sp.set('businessDateTo', format(new Date(r.to), 'yyyy-MM-dd'));
            break;
          }
          case 'completedDate': {
            const r = v as DateRangeFilterValue;
            if (r.empty) sp.set('completedDateEmpty', '1');
            if (r.from) sp.set('completedDateFrom', format(new Date(r.from), 'yyyy-MM-dd'));
            if (r.to) sp.set('completedDateTo', format(new Date(r.to), 'yyyy-MM-dd'));
            break;
          }
          case 'creatorName':
            for (const c of v as string[]) sp.append('creatorNames', c);
            break;
        }
      }
      // 权限范围(writable)转服务端项目过滤;显式项目筛选与可写集取交集(范围语义不放大)。
      if (scope === 'writable') {
        const allowed = projectIds.length
          ? projectIds.filter((id) => writableIds.has(id))
          : Array.from(writableIds);
        for (const id of allowed) sp.append('projectIds', id);
      } else {
        for (const id of projectIds) sp.append('projectIds', id);
      }
      const firstSort = sorting[0];
      if (firstSort) {
        sp.set('sortField', firstSort.id);
        sp.set('sortDir', firstSort.desc ? 'desc' : 'asc');
      }
      sp.set('page', String(targetPage));
      sp.set('pageSize', String(targetPageSize));
      return sp;
    },
    [columnFilters, sorting, scope, writableIds, idByLabel],
  );

  /** 列表重拉:服务端筛选/排序/分页,一次一页。 */
  const reloadRecords = useCallback(async () => {
    if (scope === 'writable' && writableIds.size === 0) {
      setRecords([]);
      setTotal(0);
      setStats({ totalCount: 0, validCount: 0, amountSum: '0.00' });
      setLoadingRecords(false);
      return;
    }
    setLoadingRecords(true);
    try {
      const data = await apiFetch<{
        records: UnifiedRecordRow[];
        total: number;
        stats: { totalCount: number; validCount: number; amountSum: string };
      }>(`/api/statistics/custom?${buildParams(page, pageSize).toString()}`);
      setRecords(data.records ?? []);
      setTotal(data.total ?? 0);
      setStats(data.stats ?? null);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoadingRecords(false);
    }
  }, [buildParams, page, pageSize, scope, writableIds]);

  useEffect(() => {
    // 数据拉取是 effect 的合法用途;setState 均在 Promise 回调中(异步)。
    void reloadRecords();
  }, [reloadRecords]);

  // 值列候选:项目集合或权限范围变化时拉一次(跨项目接口,全局只读)。
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    const ids = scope === 'writable' ? Array.from(writableIds) : Array.from(projectName.keys());
    for (const id of ids) qs.append('projectIds', id);
    apiFetch<{
      years: number[];
      handlerNames: string[];
      creatorNames: string[];
      subjectNames: string[];
    }>(`/api/statistics/custom-facets?${qs.toString()}`)
      .then((f) => {
        if (!cancelled) setFacets(f);
      })
      .catch(() => {
        /* 候选拉取失败不阻断列表 */
      });
    return () => {
      cancelled = true;
    };
  }, [projectName, scope, writableIds]);

  /** 项目列的稳定候选(不受本列筛选影响;writable 范围只列可写项目)。 */
  const projectOptions = useMemo(() => {
    const all = Array.from(projectName.values());
    if (scope !== 'writable') return all;
    return all.filter((label) => {
      const id = idByLabel.get(label);
      return id !== undefined && writableIds.has(id);
    });
  }, [projectName, scope, idByLabel, writableIds]);
  const creatorOptions = useMemo(() => facets?.creatorNames ?? [], [facets]);

  // Excel 式表头筛选:列定义(values=值清单勾选,text=包含,range=金额,dateRange=日期)。
  const columns = useMemo<ColumnDef<UnifiedRecordRow>[]>(
    () => [
      {
        id: 'project',
        accessorFn: (row) => projectName.get(row.projectId) ?? row.projectId,
        header: ({ column }) => (
          <HeaderFilter column={column} title="项目" type="values" options={projectOptions} />
        ),
        cell: ({ row }) => (
          <Link
            href={`/projects/${row.original.projectId}/records`}
            className="text-link underline-offset-4 hover:underline"
          >
            <span className="block max-w-44 truncate">
              {projectName.get(row.original.projectId) ?? row.original.projectId.slice(0, 8)}
            </span>
          </Link>
        ),
      },
      {
        id: 'budgetYear',
        accessorKey: 'budgetYear',
        header: ({ column }) => (
          <HeaderFilter
            column={column}
            title="年度"
            type="values"
            options={(facets?.years ?? []).map(String)}
            sortable
          />
        ),
        cell: ({ row }) => <span className="tabular-nums">{row.original.budgetYear}</span>,
      },
      {
        id: 'subject',
        accessorFn: (row) => row.subject?.name ?? '—',
        header: ({ column }) => (
          <HeaderFilter
            column={column}
            title="科目"
            type="values"
            options={facets?.subjectNames ?? []}
            sortable
          />
        ),
      },
      {
        id: 'amount',
        accessorKey: 'amount',
        header: ({ column }) => (
          <span className="block text-right">
            <HeaderFilter column={column} title="金额" type="range" sortable />
          </span>
        ),
        cell: ({ row }) => <MoneyText value={row.original.amount} riskOnNegative={false} />,
      },
      {
        id: 'businessDate',
        accessorKey: 'businessDate',
        header: ({ column }) => (
          <HeaderFilter column={column} title="申请日期" type="dateRange" sortable />
        ),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {format(new Date(row.original.businessDate), 'yyyy-MM-dd')}
          </span>
        ),
      },
      {
        id: 'status',
        accessorFn: (row) => (row.isVoid ? '__void__' : row.status),
        header: ({ column }) => (
          <HeaderFilter
            column={column}
            title="状态"
            type="values"
            options={[...BUSINESS_STATUSES, '__void__']}
            valueLabels={STATUS_FILTER_LABELS}
            sortable
          />
        ),
        cell: ({ row }) =>
          row.original.isVoid ? (
            <Badge variant="error">已作废</Badge>
          ) : (
            <Badge variant={STATUS_BADGE[row.original.status] ?? 'secondary'}>
              {STATUS_LABEL[row.original.status] ?? row.original.status}
            </Badge>
          ),
      },
      {
        id: 'handler',
        accessorKey: 'handler',
        header: ({ column }) => (
          <HeaderFilter
            column={column}
            title="经办人"
            type="values"
            options={facets?.handlerNames ?? []}
            sortable
          />
        ),
      },
      {
        id: 'summary',
        accessorKey: 'summary',
        header: ({ column }) => <HeaderFilter column={column} title="摘要" type="text" sortable />,
        cell: ({ row }) => (
          <span className="block max-w-40 truncate" title={row.original.summary}>
            {row.original.summary}
          </span>
        ),
      },
      {
        id: 'remark',
        accessorFn: (row) => row.remark ?? undefined,
        sortUndefined: 'last',
        header: ({ column }) => <HeaderFilter column={column} title="备注" type="text" sortable />,
        cell: ({ row }) =>
          row.original.remark ? (
            <span
              className="block max-w-32 truncate text-muted-foreground"
              title={row.original.remark}
            >
              {row.original.remark}
            </span>
          ) : (
            <span className="text-mute">—</span>
          ),
      },
      {
        id: 'completedDate',
        accessorKey: 'completedDate',
        header: ({ column }) => (
          <HeaderFilter
            column={column}
            title="完成日期"
            type="dateRange"
            emptyLabel="仅看无完成日期"
            sortable
          />
        ),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.completedDate
              ? format(new Date(row.original.completedDate), 'yyyy-MM-dd')
              : '—'}
          </span>
        ),
      },
      {
        id: 'creatorName',
        accessorFn: (row) => row.creatorName ?? '—',
        header: ({ column }) => (
          <HeaderFilter
            column={column}
            title="录入人"
            type="values"
            options={creatorOptions}
            sortable
          />
        ),
      },
      {
        id: 'actions',
        header: () => '操作',
        enableColumnFilter: false,
        cell: ({ row }) => <RowActions row={row.original} />,
      },
    ],
    // RowActions 闭包内引用稳定函数;projectName 随项目元数据变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectName, creatorOptions, facets],
  );

  // useReactTable 与 React Compiler 记忆化假设不兼容(官方已知,功能正常)。
  const table = useReactTable({
    data: records,
    columns,
    state: { columnFilters, sorting },
    onColumnFiltersChange: (updater) => {
      setColumnFilters(updater);
      setPage(1); // 筛选变化回到第一页
    },
    onSortingChange: (updater) => {
      setSorting(updater);
      setPage(1);
    },
    getCoreRowModel: getCoreRowModel(),
    manualFiltering: true, // 筛选/排序/分页全部在服务端(§11.3 接口)
    manualSorting: true,
    manualPagination: true,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    enableSortingRemoval: true,
    enableMultiSort: false,
  });

  // §总计行:筛选全集聚合来自服务端(所见即所总;作废行不计入金额,标签注明)。
  const totalValidCount = stats?.validCount ?? 0;
  const totalVoidCount = (stats?.totalCount ?? 0) - (stats?.validCount ?? 0);
  const amountSum = stats?.amountSum ?? '0.00';

  /** 条件 chips 的人话描述(与表头漏斗同一份 columnFilters)。 */
  const describeFilterValue = (columnId: string, value: unknown): string => {
    if (Array.isArray(value)) {
      const labelOf = (v: unknown): string => {
        if (columnId === 'project') return String(v);
        if (columnId === 'status') return STATUS_FILTER_LABELS[String(v)] ?? String(v);
        return String(v);
      };
      return value.map(labelOf).join('、');
    }
    if (columnId === 'amount') {
      const v = value as { min?: string; max?: string };
      return [v.min ? `≥ ${v.min}` : '', v.max ? `≤ ${v.max}` : ''].filter(Boolean).join(' ');
    }
    if (columnId === 'businessDate' || columnId === 'completedDate') {
      return describeDateRangeValue(value);
    }
    return String(value);
  };

  // §筛选结果导出 Excel(所见即所导;含项目列)。
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const handleExportXlsx = async () => {
    setExportingXlsx(true);
    try {
      // 所见即所导:按当前筛选逐页拉全量(单页 500,直至取满 total)。
      const all: UnifiedRecordRow[] = [];
      let cursor = 1;
      for (;;) {
        const sp = buildParams(cursor, 500);
        const data = await apiFetch<{ records: UnifiedRecordRow[]; total: number }>(
          `/api/statistics/custom?${sp.toString()}`,
        );
        all.push(...(data.records ?? []));
        if (!data.records?.length || all.length >= (data.total ?? 0) || cursor >= 200) break;
        cursor++;
      }
      await exportRecordsToXlsx(
        all.map((o) => ({
          project: projectName.get(o.projectId) ?? o.projectId.slice(0, 8),
          budgetYear: o.budgetYear,
          subject: o.subject?.name ?? o.subjectId.slice(0, 8),
          businessDate: o.businessDate,
          completedDate: o.completedDate,
          amount: o.amount,
          status: o.isVoid ? '已作废' : (STATUS_LABEL[o.status] ?? o.status),
          docNo: o.docNo,
          handler: o.handler,
          summary: o.summary,
          remark: o.remark,
          creatorName: o.creatorName,
          enteredAt: o.createdAt,
        })),
        { fileName: `业务录入-${format(new Date(), 'yyyyMMdd')}` },
      );
      toast.success(`已导出 ${all.length} 条记录`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExportingXlsx(false);
    }
  };

  /** 行内操作(修改/作废/查看;修改与作废仅可写项目且未作废)。 */
  function RowActions({ row }: { row: UnifiedRecordRow }) {
    const writable = writableIds.has(row.projectId);
    return (
      <div className="flex gap-1">
        {writable && !row.isVoid ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => void openEdit(row)}>
              修改
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-error-deep hover:bg-error-soft"
              onClick={() => {
                setVoidTarget(row);
                setVoidReason('');
                setVoidError(null);
              }}
            >
              作废
            </Button>
          </>
        ) : null}
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/projects/${row.projectId}/records?subjectId=${row.subjectId}`}>
            <History />
            查看
          </Link>
        </Button>
      </div>
    );
  }

  /** 录入提交;连续录入时保留项目/科目/经办人。 */
  const onEntrySubmit = entryForm.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const res = await apiFetch<{
        overBudget?: boolean;
        overTotalBudget?: boolean;
        overSubjectTotal?: boolean;
      }>(`/api/projects/${entryProjectId}/records`, {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          amount: Number(values.amount).toFixed(2),
          businessDate: format(values.businessDate, 'yyyy-MM-dd'),
          remark: values.remark || null,
        }),
      });
      // 预警合并为一条提示;口径细节在项目记录页的弹窗里列明。
      const overAny = res.overBudget || res.overTotalBudget || res.overSubjectTotal;
      toast.success(overAny ? '已录入(超出预算,请关注)' : '已录入');
      // 连续录入:清金额/摘要/备注,日期归零到当天,焦点留在表单。
      entryForm.reset({
        ...values,
        amount: '',
        summary: '',
        remark: '',
        businessDate: new Date(),
      });
      void reloadRecords();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  });

  /** 打开行内编辑:预填 + 确保该项目科目已加载。 */
  const openEdit = async (row: UnifiedRecordRow) => {
    await ensureSubjects(row.projectId);
    editForm.reset({
      budgetYear: row.budgetYear,
      subjectId: row.subjectId,
      amount: row.amount,
      businessDate: new Date(row.businessDate),
      status: row.status,
      handler: row.handler,
      summary: row.summary,
      remark: row.remark ?? '',
    });
    setEditing(row);
  };

  const onEditSubmit = editForm.handleSubmit(async (values) => {
    if (!editing) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/projects/${editing.projectId}/records/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...values,
          amount: Number(values.amount).toFixed(2),
          businessDate: format(values.businessDate, 'yyyy-MM-dd'),
          remark: values.remark || null,
        }),
      });
      toast.success('已保存修改');
      setEditing(null);
      void reloadRecords();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  });

  const confirmVoid = async () => {
    if (!voidTarget) return;
    const reason = voidReason.trim();
    if (!reason) {
      setVoidError('请填写作废原因');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`/api/projects/${voidTarget.projectId}/records/${voidTarget.id}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      toast.success('已作废');
      setVoidTarget(null);
      setVoidReason('');
      setVoidError(null);
      void reloadRecords();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const entrySubjects = (subjectsByProject[entryProjectId] ?? []).filter((s) => s.isLeaf);
  const editSubjects = (subjectsByProject[editing?.projectId ?? ''] ?? []).filter((s) => s.isLeaf);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Records"
        title="业务录入"
        description="跨项目统一录入与维护业务记录;可录入范围由项目成员身份决定(负责人/录入成员)。"
      />

      {/* ===== 录入卡片 ===== */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardPlus className="size-4" />
            新增记录
          </CardTitle>
        </CardHeader>
        <CardContent>
          {projects === null ? (
            <Skeleton className="h-20 w-full" />
          ) : writableProjects.length === 0 ? (
            <Alert variant="info">
              <AlertDescription>
                你暂无可录入的项目。请联系管理员将你加为项目成员(负责人或录入成员)。
              </AlertDescription>
            </Alert>
          ) : (
            <Form {...entryForm}>
              <form onSubmit={onEntrySubmit} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="grid gap-1.5">
                    <Label>项目</Label>
                    <Combobox
                      options={writableProjects.map((p) => ({
                        value: p.id,
                        label: `${p.code} ${p.name}`,
                        keywords: p.code,
                      }))}
                      value={entryProjectId}
                      onChange={(v) => {
                        setEntryProjectId(v);
                        entryForm.setValue('subjectId', '');
                        if (v) void ensureSubjects(v);
                      }}
                      placeholder="选择项目"
                      searchPlaceholder="搜索项目名称/编号…"
                      emptyText="无可录入项目"
                    />
                  </div>
                  <FormField
                    control={entryForm.control}
                    name="subjectId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>科目(叶)</FormLabel>
                        <Combobox
                          options={entrySubjects.map((s) => ({
                            value: s.id,
                            label: s.name,
                            keywords: s.code,
                          }))}
                          value={field.value}
                          onChange={field.onChange}
                          placeholder={entryProjectId ? '选择科目' : '先选项目'}
                          searchPlaceholder="搜索科目…"
                          emptyText="无叶科目"
                          disabled={!entryProjectId}
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={entryForm.control}
                    name="budgetYear"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>预算年度</FormLabel>
                        <FormControl>
                          <Input type="number" min={1900} max={9999} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={entryForm.control}
                    name="businessDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>申请日期</FormLabel>
                        <DatePicker value={field.value} onChange={field.onChange} />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <FormField
                    control={entryForm.control}
                    name="amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>金额</FormLabel>
                        <FormControl>
                          <AmountInput
                            value={field.value}
                            onChange={(v) => field.onChange(v ?? '')}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={entryForm.control}
                    name="status"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>状态</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {BUSINESS_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {STATUS_LABEL[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={entryForm.control}
                    name="handler"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>经办人</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={entryForm.control}
                    name="summary"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>摘要</FormLabel>
                        <FormControl>
                          <Input placeholder="一句话说明用途" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="flex items-end justify-between gap-3">
                  <FormField
                    control={entryForm.control}
                    name="remark"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>备注(可选)</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={submitting || !entryProjectId}>
                    {submitting ? '录入中…' : '录入并继续'}
                  </Button>
                </div>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>

      {/* ===== 记录列表(Excel 式表头筛选) ===== */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            点击表头 <Funnel className="inline size-3.5" /> 可按任意列筛选(勾选清单/文本/范围)。
          </p>
          <div className="flex items-center gap-2">
            <Select value={scope} onValueChange={(v) => setScope(v as 'writable' | 'all')}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="writable">我可录入的项目</SelectItem>
                <SelectItem value="all">全部项目(只读)</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => void reloadRecords()}
              disabled={loadingRecords}
            >
              刷新
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleExportXlsx()}
              disabled={exportingXlsx || total === 0}
            >
              <Download />
              {exportingXlsx ? '导出中…' : '导出筛选结果'}
            </Button>
          </div>
        </div>

        {/* 当前生效筛选的条件 chips(与表头漏斗同一份状态) */}
        <ActiveFilterChips
          filters={columnFilters}
          labels={{
            project: '项目',
            budgetYear: '年度',
            subject: '科目',
            amount: '金额',
            businessDate: '申请日期',
            status: '状态',
            handler: '经办人',
            summary: '摘要',
            remark: '备注',
            completedDate: '完成日期',
            creatorName: '录入人',
          }}
          describe={describeFilterValue}
          onRemove={(id) => {
            setColumnFilters((prev) => prev.filter((c) => c.id !== id));
            setPage(1);
          }}
          onClearAll={() => {
            setColumnFilters([]);
            setPage(1);
          }}
        />

        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={
                        header.column.id === 'amount'
                          ? 'w-32 text-right'
                          : header.column.id === 'actions'
                            ? 'w-44'
                            : undefined
                      }
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {/* §总计行:首行显示当前筛选结果的笔数与金额合计(作废不计)。 */}
              {!loadingRecords && records.length > 0 ? (
                <TableRow className="border-b border-border bg-muted/40 font-medium hover:bg-muted/40">
                  {table.getVisibleLeafColumns().map((col, idx) => (
                    <TableCell key={col.id} className="py-1.5">
                      {col.id === 'amount' ? (
                        <span className="block text-right tabular-nums">{amountSum}</span>
                      ) : idx === 0 ? (
                        <span className="whitespace-nowrap tabular-nums">
                          总计 {totalValidCount} 笔{totalVoidCount > 0 ? '(作废不计)' : ''}
                        </span>
                      ) : null}
                    </TableCell>
                  ))}
                </TableRow>
              ) : null}
              {loadingRecords ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {table.getAllLeafColumns().map((col) => (
                      <TableCell key={col.id}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={table.getAllLeafColumns().length}
                    className="py-10 text-center text-muted-foreground"
                  >
                    暂无匹配记录
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {!loadingRecords && table.getRowModel().rows.length > 0 ? (
            <div className="border-t border-border px-4 py-2 text-xs text-mute tabular-nums">
              共 {total} 条记录
              {columnFilters.length > 0 ? '(已应用表头筛选)' : ''}
            </div>
          ) : null}
          {!loadingRecords && total > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
              </span>
              <select
                className="h-8 rounded-md border border-border bg-card px-2 text-sm"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="每页条数"
              >
                {[50, 100, 200].map((n) => (
                  <option key={n} value={n}>
                    {n} 条/页
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loadingRecords}
                onClick={() => setPage((v) => Math.max(1, v - 1))}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= Math.ceil(total / pageSize) || loadingRecords}
                onClick={() => setPage((v) => Math.min(Math.ceil(total / pageSize), v + 1))}
              >
                下一页
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {/* ===== 编辑 Dialog ===== */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>修改业务记录</DialogTitle>
          </DialogHeader>
          {editing ? (
            <Form {...editForm}>
              <form onSubmit={onEditSubmit} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField
                    control={editForm.control}
                    name="subjectId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>科目(叶)</FormLabel>
                        <Combobox
                          options={editSubjects.map((s) => ({
                            value: s.id,
                            label: s.name,
                            keywords: s.code,
                          }))}
                          value={field.value}
                          onChange={field.onChange}
                          searchPlaceholder="搜索科目…"
                          emptyText="无叶科目"
                        />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="budgetYear"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>预算年度</FormLabel>
                        <FormControl>
                          <Input type="number" min={1900} max={9999} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="businessDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>申请日期</FormLabel>
                        <DatePicker value={field.value} onChange={field.onChange} />
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>金额</FormLabel>
                        <FormControl>
                          <AmountInput
                            value={field.value}
                            onChange={(v) => field.onChange(v ?? '')}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="handler"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>经办人</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="summary"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>摘要</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={editForm.control}
                  name="remark"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>备注(可选)</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                    取消
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? '保存中…' : '保存'}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ===== 作废 Dialog ===== */}
      <Dialog open={voidTarget !== null} onOpenChange={(open) => !open && setVoidTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>作废业务记录</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              作废后不再计入占用,操作会留痕且不可撤销。
            </p>
            <div className="grid gap-1.5">
              <Label>作废原因(必填)</Label>
              <Input
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder="如:重复录入"
              />
              {voidError ? <p className="text-xs text-destructive">{voidError}</p> : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoidTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmVoid} disabled={submitting}>
              {submitting ? '作废中…' : '确认作废'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** useSearchParams 需要Suspense 边界(Next.js 预渲染要求)。 */
export default function UnifiedRecordsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <UnifiedRecordsPageInner />
    </Suspense>
  );
}
