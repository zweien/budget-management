'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { ChevronDown, Plus } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { apiFetch } from '@/lib/api/client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AmountInput } from '@/components/ui/AmountInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

/** §8 业务记录四态(与 Prisma BusinessStatus 同步,不依赖运行时枚举以避免在 client bundle 里强引 @prisma/client)。 */
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

/** §17.7 history.action 的中文展示。 */
const HISTORY_ACTION_LABEL: Record<string, string> = {
  create: '新增',
  update: '修改',
  void: '作废',
  status_switch: '状态切换',
  carryover_out: '结转(源)',
  carryover_in: '结转(新)',
};

/** 业务记录行(对应 GET /records 返回的 BusinessRecord 列)。 */
interface BusinessRecordRow {
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
  remark: string | null;
  isVoid: boolean;
  voidReason: string | null;
  voidedBy: string | null;
  voidedAt: string | null;
  createdById: string;
  createdAt: string;
}

/** §17.7 业务记录变更历史行(对应 business_record_history)。 */
interface BusinessRecordHistoryRow {
  id: string;
  businessRecordId: string;
  action: string;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  operatorId: string;
  operatedAt: string;
  reason: string | null;
}

/** 叶科目(用于筛选 + 新增表单的科目下拉,从 ledger nodes 中 isLeaf=true 取得)。 */
interface LeafSubject {
  subjectId: string;
  code: string;
  name: string;
}

interface ProjectDetail {
  id: string;
  code: string;
  name: string;
}

interface LedgerResponse {
  year: number;
  nodes: Array<{
    subjectId: string;
    code: string;
    name: string;
    isLeaf: boolean;
  }>;
}

/** 生成最近 5 年的年度选项(含当前年,按降序)。 */
function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

/** 把 BusinessRecord.businessDate(可能是 ISO 或带 T 的字符串)统一为 YYYY-MM-DD 展示。 */
function formatDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd');
}

/** 把时间戳统一为 YYYY-MM-DD HH:mm 展示。 */
function formatDateTime(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm');
}

const recordSchema = z.object({
  budgetYear: z.coerce
    .number({ message: '请输入年度' })
    .int('年度须为整数')
    .min(1900, '年度不合法')
    .max(9999, '年度不合法'),
  subjectId: z.string().min(1, '请选择科目'),
  amount: z.string({ message: '请输入金额' }).min(1, '请输入金额'),
  businessDate: z.date({ message: '请选择日期' }),
  handler: z.string().trim().min(1, '请输入经办人').max(64),
  summary: z.string().trim().min(1, '请输入摘要').max(200),
  status: z.enum(BUSINESS_STATUSES, { message: '请选择状态' }),
  remark: z.string().trim().max(500),
});

type RecordFormValues = z.infer<typeof recordSchema>;

/** Select 的"全部"哨兵值(radix SelectItem 不允许空串)。 */
const ALL = '__all__';

export default function BusinessRecordsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  // 项目标题(仅用于错误态;标题由项目壳承载)。
  const [project, setProject] = useState<ProjectDetail | null>(null);
  // 叶科目列表(用于筛选 + 新增/修改表单)。
  const [leafSubjects, setLeafSubjects] = useState<LeafSubject[]>([]);
  // 业务记录列表。
  const [records, setRecords] = useState<BusinessRecordRow[]>([]);
  // 筛选状态。
  const [yearFilter, setYearFilter] = useState<number | undefined>(undefined);
  const [subjectFilter, setSubjectFilter] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<BusinessStatus | undefined>(undefined);
  const [includeVoid, setIncludeVoid] = useState(false);
  // 加载/错误。
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  // 提交中。
  const [submitting, setSubmitting] = useState(false);
  // 新增/修改 Dialog。
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BusinessRecordRow | null>(null);
  // §8.4 超预算预警(已保存)。
  const [overBudgetOpen, setOverBudgetOpen] = useState(false);
  // 作废 Dialog。
  const [voidTarget, setVoidTarget] = useState<BusinessRecordRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidError, setVoidError] = useState<string | null>(null);
  // §17.7 历史 Sheet。
  const [historyTarget, setHistoryTarget] = useState<BusinessRecordRow | null>(null);
  const [historyRows, setHistoryRows] = useState<BusinessRecordHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const form = useForm<RecordFormValues>({
    resolver: zodResolver(recordSchema),
    defaultValues: {
      budgetYear: new Date().getFullYear(),
      status: 'PLACEHOLDER',
      handler: '',
      summary: '',
      remark: '',
    },
  });

  // subjectId → {code, name} 映射,用于表格展示。
  const subjectMap = useMemo(() => {
    const m = new Map<string, LeafSubject>();
    for (const s of leafSubjects) m.set(s.subjectId, s);
    return m;
  }, [leafSubjects]);

  // 拉取项目 + 叶科目(仅一次)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [proj, ledger] = await Promise.all([
          apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
          apiFetch<LedgerResponse>(`/api/projects/${projectId}/ledger`),
        ]);
        if (cancelled) return;
        setProject(proj);
        const leaves: LeafSubject[] = (ledger.nodes ?? [])
          .filter((n) => n.isLeaf)
          .map((n) => ({ subjectId: n.subjectId, code: n.code, name: n.name }))
          .sort((a, b) => a.code.localeCompare(b.code));
        setLeafSubjects(leaves);
      } catch (e) {
        if (!cancelled) {
          if (e instanceof Error) toast.error(e.message);
          setFatal(e instanceof Error ? e.message : '加载项目信息失败');
        }
      } finally {
        if (!cancelled) setLoadingMeta(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 拉取业务记录(随筛选变化重拉)。
  // loading 重置放在筛选事件处理器里(事件驱动),effect 内只发请求 + 异步落结果。
  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (yearFilter !== undefined) qs.set('year', String(yearFilter));
    if (subjectFilter) qs.set('subjectId', subjectFilter);
    if (statusFilter) qs.set('status', statusFilter);
    if (includeVoid) qs.set('includeVoid', '1');
    const suffix = qs.toString();
    apiFetch<{ records: BusinessRecordRow[] }>(
      `/api/projects/${projectId}/records${suffix ? `?${suffix}` : ''}`,
    )
      .then((data) => {
        if (!cancelled) setRecords(data.records ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) toast.error(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingRecords(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, yearFilter, subjectFilter, statusFilter, includeVoid]);

  /** 在变更(新增/修改/作废/状态切换)后重新拉取列表。 */
  const reloadRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const qs = new URLSearchParams();
      if (yearFilter !== undefined) qs.set('year', String(yearFilter));
      if (subjectFilter) qs.set('subjectId', subjectFilter);
      if (statusFilter) qs.set('status', statusFilter);
      if (includeVoid) qs.set('includeVoid', '1');
      const suffix = qs.toString();
      const data = await apiFetch<{ records: BusinessRecordRow[] }>(
        `/api/projects/${projectId}/records${suffix ? `?${suffix}` : ''}`,
      );
      setRecords(data.records ?? []);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoadingRecords(false);
    }
  }, [projectId, yearFilter, subjectFilter, statusFilter, includeVoid]);

  /** 打开"新增"Dialog。 */
  const openCreate = () => {
    setEditing(null);
    form.reset({
      budgetYear: new Date().getFullYear(),
      subjectId: undefined,
      amount: undefined,
      businessDate: new Date(),
      handler: '',
      summary: '',
      status: 'PLACEHOLDER',
      remark: '',
    });
    setFormOpen(true);
  };

  /** 打开"修改"Dialog,预填当前行。 */
  const openEdit = (row: BusinessRecordRow) => {
    setEditing(row);
    form.reset({
      budgetYear: row.budgetYear,
      subjectId: row.subjectId,
      amount: row.amount,
      businessDate: new Date(row.businessDate),
      handler: row.handler,
      summary: row.summary,
      status: row.status,
      remark: row.remark ?? '',
    });
    setFormOpen(true);
  };

  /**
   * 提交新增/修改。
   * keepOpen(连续录入):仅新增模式可用——保存后保留 年度/科目/经办人/日期/状态,
   * 清空金额/摘要/备注并聚焦金额,快速录入下一条。
   */
  const submitForm = (keepOpen: boolean) =>
    form.handleSubmit(async (values) => {
      const payload = {
        budgetYear: values.budgetYear,
        subjectId: values.subjectId,
        amount: values.amount,
        businessDate: format(values.businessDate, 'yyyy-MM-dd'),
        handler: values.handler,
        summary: values.summary,
        status: values.status,
        remark: values.remark || null,
      };
      setSubmitting(true);
      try {
        if (editing) {
          const res = await apiFetch<{ record: BusinessRecordRow; overBudget: boolean }>(
            `/api/projects/${projectId}/records/${editing.id}`,
            { method: 'PATCH', body: JSON.stringify(payload) },
          );
          toast.success('已保存修改');
          if (res.overBudget) setOverBudgetOpen(true);
          setFormOpen(false);
        } else {
          const res = await apiFetch<{ record: BusinessRecordRow; overBudget: boolean }>(
            `/api/projects/${projectId}/records`,
            { method: 'POST', body: JSON.stringify(payload) },
          );
          toast.success('已新增业务记录');
          if (res.overBudget) setOverBudgetOpen(true);
          if (keepOpen) {
            form.reset({
              budgetYear: values.budgetYear,
              subjectId: values.subjectId,
              amount: undefined,
              businessDate: values.businessDate,
              handler: values.handler,
              summary: '',
              status: values.status,
              remark: '',
            });
            form.setFocus('amount');
          } else {
            setFormOpen(false);
          }
        }
        await reloadRecords();
      } catch (e) {
        if (e instanceof Error) toast.error(e.message);
      } finally {
        setSubmitting(false);
      }
    })();

  /** 提交作废(原因必填)。 */
  const submitVoid = async () => {
    if (!voidTarget) return;
    const reason = voidReason.trim();
    if (!reason) {
      setVoidError('请填写作废原因');
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch<{ record: BusinessRecordRow }>(
        `/api/projects/${projectId}/records/${voidTarget.id}/void`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      );
      toast.success('已作废');
      setVoidTarget(null);
      setVoidReason('');
      setVoidError(null);
      await reloadRecords();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 筛选变化:同步重置 loading,随后由 effect 重拉数据。 */
  const applyFilter = <K,>(setter: (v: K) => void, value: K) => {
    setLoadingRecords(true);
    setter(value);
  };

  /** 切换状态(下拉菜单触发)。 */
  const switchStatus = async (row: BusinessRecordRow, next: BusinessStatus) => {
    if (next === row.status) return;
    try {
      await apiFetch<{ record: BusinessRecordRow }>(
        `/api/projects/${projectId}/records/${row.id}/status`,
        { method: 'POST', body: JSON.stringify({ status: next }) },
      );
      toast.success(`状态已切换为:${STATUS_LABEL[next]}`);
      await reloadRecords();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  };

  /** §17.7 打开变更历史 Sheet,拉取该记录的 history 行。 */
  const openHistory = async (row: BusinessRecordRow) => {
    setHistoryTarget(row);
    setHistoryRows([]);
    setHistoryLoading(true);
    try {
      const data = await apiFetch<{ history: BusinessRecordHistoryRow[] }>(
        `/api/projects/${projectId}/records/${row.id}/history`,
      );
      setHistoryRows(data.history ?? []);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  if (loadingMeta) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (fatal || !project) {
    return (
      <Alert variant="error">
        <AlertTitle>无法访问该项目</AlertTitle>
        <AlertDescription>{fatal ?? '项目可能不存在或您没有访问权限。'}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {/* 筛选行 + 新增 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid w-32 gap-1.5">
            <Label>年度</Label>
            <Select
              value={yearFilter !== undefined ? String(yearFilter) : ALL}
              onValueChange={(v) => applyFilter(setYearFilter, v === ALL ? undefined : Number(v))}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部年度" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部年度</SelectItem>
                {yearOptions().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y} 年
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid w-52 gap-1.5">
            <Label>科目</Label>
            <Select
              value={subjectFilter ?? ALL}
              onValueChange={(v) => applyFilter(setSubjectFilter, v === ALL ? undefined : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部科目" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部科目</SelectItem>
                {leafSubjects.map((s) => (
                  <SelectItem key={s.subjectId} value={s.subjectId}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid w-36 gap-1.5">
            <Label>状态</Label>
            <Select
              value={statusFilter ?? ALL}
              onValueChange={(v) =>
                applyFilter(setStatusFilter, v === ALL ? undefined : (v as BusinessStatus))
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
          <label className="flex h-8 cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={includeVoid}
              onCheckedChange={(checked) => applyFilter(setIncludeVoid, checked === true)}
            />
            包含作废
          </label>
        </div>
        <Button onClick={openCreate}>
          <Plus />
          新增
        </Button>
      </div>

      {/* 记录表 */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-20">年度</TableHead>
              <TableHead>科目</TableHead>
              <TableHead className="w-32 text-right">金额</TableHead>
              <TableHead className="w-32">业务发生日期</TableHead>
              <TableHead className="w-32">状态</TableHead>
              <TableHead className="w-24">经办人</TableHead>
              <TableHead>摘要</TableHead>
              <TableHead className="w-40">录入时间</TableHead>
              <TableHead className="w-60">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadingRecords ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={9}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : records.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">
                  暂无业务记录
                </TableCell>
              </TableRow>
            ) : (
              records.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="tabular-nums">{row.budgetYear}</TableCell>
                  <TableCell>
                    {subjectMap.get(row.subjectId)?.name ?? (
                      <span className="font-mono text-xs text-mute">
                        {row.subjectId.slice(0, 8)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <MoneyText value={row.amount} riskOnNegative={false} />
                  </TableCell>
                  <TableCell className="tabular-nums">{formatDate(row.businessDate)}</TableCell>
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
                  <TableCell className="tabular-nums">{formatDateTime(row.enteredAt)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(row)}
                        disabled={row.isVoid}
                      >
                        修改
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" disabled={row.isVoid}>
                            状态
                            <ChevronDown />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {BUSINESS_STATUSES.filter((s) => s !== row.status).map((s) => (
                            <DropdownMenuItem key={s} onClick={() => void switchStatus(row, s)}>
                              切换为:{STATUS_LABEL[s]}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-error-deep hover:bg-error-soft"
                        onClick={() => {
                          setVoidTarget(row);
                          setVoidReason('');
                          setVoidError(null);
                        }}
                        disabled={row.isVoid}
                      >
                        作废
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void openHistory(row)}>
                        历史
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {!loadingRecords && records.length > 0 ? (
          <div className="border-t border-border px-4 py-2 text-xs text-mute tabular-nums">
            共 {records.length} 条记录
          </div>
        ) : null}
      </div>

      {/* 新增/修改 Dialog(react-hook-form + zod) */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? '修改业务记录' : '新增业务记录'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="budgetYear"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>年度</FormLabel>
                      <FormControl>
                        <Input type="number" min={1900} max={9999} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>状态</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="选择状态" />
                        </SelectTrigger>
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
              </div>
              <FormField
                control={form.control}
                name="subjectId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>科目</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择叶科目" />
                      </SelectTrigger>
                      <SelectContent>
                        {leafSubjects.map((s) => (
                          <SelectItem key={s.subjectId} value={s.subjectId}>
                            {s.code} {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>金额</FormLabel>
                      <FormControl>
                        <AmountInput
                          value={field.value}
                          onChange={field.onChange}
                          aria-invalid={!!form.formState.errors.amount}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
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
              <FormField
                control={form.control}
                name="handler"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>经办人</FormLabel>
                    <FormControl>
                      <Input maxLength={64} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="summary"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>摘要</FormLabel>
                    <FormControl>
                      <Input maxLength={200} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Textarea maxLength={500} rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setFormOpen(false)}
                  disabled={submitting}
                >
                  取消
                </Button>
                {!editing ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void submitForm(true)}
                    disabled={submitting}
                  >
                    保存并继续新增
                  </Button>
                ) : null}
                <Button type="button" onClick={() => void submitForm(false)} disabled={submitting}>
                  {submitting ? '保存中…' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* §8.4 超预算预警(记录已保存) */}
      <AlertDialog open={overBudgetOpen} onOpenChange={setOverBudgetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>该记录导致超预算,但已保存</AlertDialogTitle>
            <AlertDialogDescription>
              本次登记使该科目在该年度的占用超过当前预算。记录已保存,请及时跟进预算调整。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction>知道了</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 作废 Dialog(原因必填,原生受控 textarea) */}
      <Dialog
        open={voidTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setVoidTarget(null);
            setVoidReason('');
            setVoidError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>作废业务记录</DialogTitle>
          </DialogHeader>
          {voidTarget ? (
            <div className="space-y-3">
              <Alert variant="warning">
                <AlertTitle>
                  将作废记录:{formatDate(voidTarget.businessDate)} ·{' '}
                  {subjectMap.get(voidTarget.subjectId)?.name ?? ''} · {voidTarget.summary}
                </AlertTitle>
                <AlertDescription>作废后该记录占用将由台账实时解除,不可恢复。</AlertDescription>
              </Alert>
              <div className="grid gap-1.5">
                <Label htmlFor="void-reason">作废原因</Label>
                <Textarea
                  id="void-reason"
                  maxLength={200}
                  rows={3}
                  placeholder="请填写作废原因"
                  value={voidReason}
                  onChange={(e) => {
                    setVoidReason(e.target.value);
                    if (voidError) setVoidError(null);
                  }}
                  aria-invalid={!!voidError}
                />
                {voidError ? <p className="text-xs text-destructive">{voidError}</p> : null}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setVoidTarget(null);
                setVoidReason('');
                setVoidError(null);
              }}
              disabled={submitting}
            >
              取消
            </Button>
            <Button variant="destructive" onClick={() => void submitVoid()} disabled={submitting}>
              {submitting ? '提交中…' : '确认作废'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* §17.7 变更历史 Sheet */}
      <Sheet open={historyTarget !== null} onOpenChange={(open) => !open && setHistoryTarget(null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-6 sm:max-w-xl">
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>变更历史</SheetTitle>
          </SheetHeader>
          {historyTarget ? (
            <div className="space-y-4">
              <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border">
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">业务发生日期</dt>
                  <dd className="mt-1 text-sm tabular-nums">
                    {formatDate(historyTarget.businessDate)}
                  </dd>
                </div>
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">摘要</dt>
                  <dd className="mt-1 text-sm">{historyTarget.summary}</dd>
                </div>
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">金额</dt>
                  <dd className="mt-1 text-sm">
                    <MoneyText value={historyTarget.amount} riskOnNegative={false} />
                  </dd>
                </div>
              </dl>

              <p className="text-sm text-muted-foreground">
                §17.7 变更链(按时间正序),共 {historyRows.length} 条。
              </p>

              {historyLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : historyRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">暂无变更历史</p>
              ) : (
                <div className="space-y-3">
                  {historyRows.map((h) => (
                    <div
                      key={h.id}
                      className="rounded-lg border border-border bg-card p-3 text-sm shadow-l1"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary">
                          {HISTORY_ACTION_LABEL[h.action] ?? h.action}
                        </Badge>
                        <span className="text-xs text-mute tabular-nums">
                          {formatDateTime(h.operatedAt)}
                        </span>
                        <span className="font-mono text-xs text-mute">
                          {h.operatorId.slice(0, 8)}
                        </span>
                      </div>
                      {h.reason ? (
                        <p className="mt-1.5 text-sm text-muted-foreground">原因:{h.reason}</p>
                      ) : null}
                      {h.beforeData || h.afterData ? (
                        <div className="mt-2 grid gap-2">
                          {h.beforeData ? (
                            <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                              {JSON.stringify(h.beforeData, null, 2)}
                            </pre>
                          ) : null}
                          {h.afterData ? (
                            <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                              {JSON.stringify(h.afterData, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
