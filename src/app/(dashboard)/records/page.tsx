'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ClipboardPlus, History, Search } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import type { DateRange } from 'react-day-picker';

import { apiFetch } from '@/lib/api/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AmountInput } from '@/components/ui/AmountInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { DateRangePicker } from '@/components/ui/date-range-picker';
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

const BUSINESS_STATUSES = ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVED', 'PAID'] as const;
type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

const STATUS_LABEL: Record<string, string> = {
  PLACEHOLDER: '登记占位',
  CONTRACT: '合同签订',
  FINANCE_APPROVED: '财务审批',
  PAID: '已支出',
};

const STATUS_BADGE: Record<string, 'secondary' | 'warning' | 'success' | 'outline'> = {
  PLACEHOLDER: 'secondary',
  CONTRACT: 'warning',
  FINANCE_APPROVED: 'outline',
  PAID: 'success',
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

const ALL = '__all__';

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
  const [projectFilter, setProjectFilter] = useState<string>(ALL);
  const [handlerFilter, setHandlerFilter] = useState('');
  const [summaryFilter, setSummaryFilter] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);

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

  /** 列表重拉:服务端按 handler/日期范围过滤,其余在客户端。 */
  const reloadRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const qs = new URLSearchParams();
      if (handlerFilter) qs.set('handler', handlerFilter);
      if (dateRange?.from) qs.set('businessDateFrom', format(dateRange.from, 'yyyy-MM-dd'));
      if (dateRange?.to) qs.set('businessDateTo', format(dateRange.to, 'yyyy-MM-dd'));
      const suffix = qs.toString();
      const data = await apiFetch<{ records: UnifiedRecordRow[] }>(
        `/api/statistics/custom${suffix ? `?${suffix}` : ''}`,
      );
      setRecords(data.records ?? []);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoadingRecords(false);
    }
  }, [handlerFilter, dateRange]);

  useEffect(() => {
    // 数据拉取是 effect 的合法用途;setState 均在 Promise 回调中(异步)。禁用误报(仓库约定)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadRecords();
  }, [reloadRecords]);

  /** 客户端组合过滤:范围(可录入/全部)+ 项目 + 摘要关键词。 */
  const visibleRecords = useMemo(() => {
    let rows = records;
    if (scope === 'writable') rows = rows.filter((r) => writableIds.has(r.projectId));
    if (projectFilter !== ALL) rows = rows.filter((r) => r.projectId === projectFilter);
    if (summaryFilter) {
      const kw = summaryFilter.toLowerCase();
      rows = rows.filter((r) => r.summary.toLowerCase().includes(kw));
    }
    return rows;
  }, [records, scope, writableIds, projectFilter, summaryFilter]);

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

      {/* ===== 记录列表 ===== */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid w-40 gap-1.5">
              <Label>范围</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as 'writable' | 'all')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="writable">我可录入的项目</SelectItem>
                  <SelectItem value="all">全部项目(只读)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid w-56 gap-1.5">
              <Label>项目</Label>
              <Select value={projectFilter} onValueChange={setProjectFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部项目</SelectItem>
                  {(projects ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.code} {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid w-36 gap-1.5">
              <Label>经办人</Label>
              <Input
                key={handlerFilter}
                defaultValue={handlerFilter}
                placeholder="包含匹配"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setHandlerFilter(e.currentTarget.value.trim());
                }}
                onBlur={(e) => {
                  if (e.target.value.trim() !== handlerFilter)
                    setHandlerFilter(e.target.value.trim());
                }}
              />
            </div>
            <div className="grid w-44 gap-1.5">
              <Label>摘要关键词</Label>
              <Input
                value={summaryFilter}
                placeholder="即时过滤"
                onChange={(e) => setSummaryFilter(e.target.value.trim())}
              />
            </div>
            <div className="grid w-64 gap-1.5">
              <Label>业务日期</Label>
              <DateRangePicker value={dateRange} onChange={setDateRange} placeholder="全部日期" />
            </div>
          </div>
          <Button variant="outline" onClick={() => void reloadRecords()} disabled={loadingRecords}>
            <Search />
            刷新
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>项目</TableHead>
                <TableHead className="w-20">年度</TableHead>
                <TableHead>科目</TableHead>
                <TableHead className="w-32 text-right">金额</TableHead>
                <TableHead className="w-32">业务日期</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-24">经办人</TableHead>
                <TableHead>摘要</TableHead>
                <TableHead className="w-44">操作</TableHead>
              </TableRow>
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
              ) : visibleRecords.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                    暂无匹配记录
                  </TableCell>
                </TableRow>
              ) : (
                visibleRecords.map((row) => {
                  const writable = writableIds.has(row.projectId);
                  return (
                    <TableRow key={row.id}>
                      <TableCell
                        className="max-w-44 truncate"
                        title={projectName.get(row.projectId)}
                      >
                        <Link
                          href={`/projects/${row.projectId}/records`}
                          className="text-link underline-offset-4 hover:underline"
                        >
                          {projectName.get(row.projectId) ?? row.projectId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums">{row.budgetYear}</TableCell>
                      <TableCell>{row.subject?.name ?? '—'}</TableCell>
                      <TableCell>
                        <MoneyText value={row.amount} riskOnNegative={false} />
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {format(new Date(row.businessDate), 'yyyy-MM-dd')}
                      </TableCell>
                      <TableCell>
                        {row.isVoid ? (
                          <Badge variant="error">已作废</Badge>
                        ) : (
                          <Badge variant={STATUS_BADGE[row.status] ?? 'secondary'}>
                            {STATUS_LABEL[row.status] ?? row.status}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{row.handler}</TableCell>
                      <TableCell className="max-w-40 truncate" title={row.summary}>
                        {row.summary}
                      </TableCell>
                      <TableCell>
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
                            <Link
                              href={`/projects/${row.projectId}/records?subjectId=${row.subjectId}`}
                            >
                              <History />
                              查看
                            </Link>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {!loadingRecords && visibleRecords.length > 0 ? (
            <div className="border-t border-border px-4 py-2 text-xs text-mute tabular-nums">
              共 {visibleRecords.length} 条记录
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
