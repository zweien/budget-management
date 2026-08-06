'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ClipboardPlus, Funnel, History } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import {
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
} from '@tanstack/react-table';

import { apiFetch } from '@/lib/api/client';
import { HeaderFilter } from '@/components/ui/data-table-filter';
import { dateRange, multiSelect, numberRange, textContains } from '@/lib/table/filter-fns';
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
  status: BusinessStatus;
  handler: string;
  summary: string;
  remark: string | null;
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
  businessDate: z.date({ message: '请选择业务发生日期' }),
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
export default function UnifiedRecordsPage() {
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
  // Excel 式表头筛选(TanStack columnFilters;空数组=不过滤)。
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

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

  /** 列表重拉:全量拉取(表头筛选全部在客户端进行,Excel 式即时过滤)。 */
  const reloadRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      // 含作废记录:状态列默认排除已作废,但勾选「已作废」后需能看到;作废可见性由客户端筛选控制。
      const data = await apiFetch<{ records: UnifiedRecordRow[] }>(
        '/api/statistics/custom?includeVoid=1',
      );
      setRecords(data.records ?? []);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  useEffect(() => {
    // 数据拉取是 effect 的合法用途;setState 均在 Promise 回调中(异步)。
    void reloadRecords();
  }, [reloadRecords]);

  /** 范围过滤(权限范围,非数据筛选):可录入项目 或 全部(只读)。 */
  const tableData = useMemo(
    () => (scope === 'writable' ? records.filter((r) => writableIds.has(r.projectId)) : records),
    [records, scope, writableIds],
  );

  /** 项目列的稳定候选(不受本列筛选影响)。 */
  const projectOptions = useMemo(() => Array.from(projectName.values()), [projectName]);

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
        filterFn: multiSelect<UnifiedRecordRow>(),
      },
      {
        id: 'budgetYear',
        accessorKey: 'budgetYear',
        header: ({ column }) => <HeaderFilter column={column} title="年度" type="values" />,
        cell: ({ row }) => <span className="tabular-nums">{row.original.budgetYear}</span>,
        filterFn: multiSelect<UnifiedRecordRow>(),
      },
      {
        id: 'subject',
        accessorFn: (row) => row.subject?.name ?? '—',
        header: ({ column }) => <HeaderFilter column={column} title="科目" type="values" />,
        filterFn: multiSelect<UnifiedRecordRow>(),
      },
      {
        id: 'amount',
        accessorKey: 'amount',
        header: ({ column }) => (
          <span className="block text-right">
            <HeaderFilter column={column} title="金额" type="range" />
          </span>
        ),
        cell: ({ row }) => <MoneyText value={row.original.amount} riskOnNegative={false} />,
        filterFn: numberRange<UnifiedRecordRow>(),
      },
      {
        id: 'businessDate',
        accessorKey: 'businessDate',
        header: ({ column }) => <HeaderFilter column={column} title="业务日期" type="dateRange" />,
        cell: ({ row }) => (
          <span className="tabular-nums">
            {format(new Date(row.original.businessDate), 'yyyy-MM-dd')}
          </span>
        ),
        filterFn: dateRange<UnifiedRecordRow>(),
      },
      {
        id: 'status',
        accessorFn: (row) => (row.isVoid ? '__void__' : row.status),
        header: ({ column }) => (
          <HeaderFilter
            column={column}
            title="状态"
            type="values"
            valueLabels={STATUS_FILTER_LABELS}
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
        filterFn: multiSelect<UnifiedRecordRow>(),
      },
      {
        id: 'handler',
        accessorKey: 'handler',
        header: ({ column }) => <HeaderFilter column={column} title="经办人" type="values" />,
        filterFn: multiSelect<UnifiedRecordRow>(),
      },
      {
        id: 'summary',
        accessorKey: 'summary',
        header: ({ column }) => <HeaderFilter column={column} title="摘要" type="text" />,
        cell: ({ row }) => (
          <span className="block max-w-40 truncate" title={row.original.summary}>
            {row.original.summary}
          </span>
        ),
        filterFn: textContains<UnifiedRecordRow>(),
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
    [projectName],
  );

  // useReactTable 与 React Compiler 记忆化假设不兼容(官方已知,功能正常)。
  const table = useReactTable({
    data: tableData,
    columns,
    state: { columnFilters },
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

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
      const res = await apiFetch<{ overBudget?: boolean }>(
        `/api/projects/${entryProjectId}/records`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...values,
            amount: Number(values.amount).toFixed(2),
            businessDate: format(values.businessDate, 'yyyy-MM-dd'),
            remark: values.remark || null,
          }),
        },
      );
      toast.success(res.overBudget ? '已录入(超出预算,请关注)' : '已录入');
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
                        <FormLabel>业务发生日期</FormLabel>
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
          </div>
        </div>

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
              {loadingRecords ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
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
              共 {table.getRowModel().rows.length} 条记录
              {columnFilters.length > 0 ? '(已应用表头筛选)' : ''}
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
                        <FormLabel>业务发生日期</FormLabel>
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
