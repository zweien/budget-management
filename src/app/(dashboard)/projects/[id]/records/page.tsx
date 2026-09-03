'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import { ChevronDown, FolderArchive, Funnel, Paperclip, Package, Plus, Upload } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import {
  getSortedRowModel,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
} from '@tanstack/react-table';

import { apiFetch } from '@/lib/api/client';
import { exportAttachmentsZip, uploadAttachment } from '@/lib/api/attachments';
import { D } from '@/lib/decimal';
import { HeaderFilter } from '@/components/ui/data-table-filter';
import { AttachmentSheet } from '@/components/records/AttachmentSheet';
import { PackageAttachmentsDialog } from '@/components/records/PackageAttachmentsDialog';
import { dateRange, multiSelect, numberRange, textContains } from '@/lib/table/filter-fns';
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
import { Combobox } from '@/components/ui/combobox';
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

/** 状态筛选清单的展示映射(含作废哨兵)。 */
const STATUS_FILTER_LABELS: Record<string, string> = {
  PLACEHOLDER: STATUS_LABEL.PLACEHOLDER,
  CONTRACT: STATUS_LABEL.CONTRACT,
  FINANCE_APPROVAL: STATUS_LABEL.FINANCE_APPROVAL,
  PAID: STATUS_LABEL.PAID,
  __void__: '已作废',
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
  docNo: string | null;
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
  /** 服务端随详情下发:是否可录入/维护业务记录(OWNER/HANDLER;决定新增/修改/状态/作废入口)。 */
  canWriteRecords?: boolean;
  /** 是否有项目编辑权(ADMIN/OWNER;决定 Excel 导入入口,record:import 与之一致)。 */
  canEdit?: boolean;
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
  docNo: z.string().trim().max(64, '单据编号过长'),
  remark: z.string().trim().max(500),
});

type RecordFormValues = z.infer<typeof recordSchema>;

/** Select 的"全部"哨兵值(radix SelectItem 不允许空串)。 */

function BusinessRecordsPageInner() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const projectId = params.id;

  // 项目标题(仅用于错误态;标题由项目壳承载)。
  const [project, setProject] = useState<ProjectDetail | null>(null);
  // 叶科目列表(用于筛选 + 新增/修改表单)。
  const [leafSubjects, setLeafSubjects] = useState<LeafSubject[]>([]);
  // 业务记录列表。
  const [records, setRecords] = useState<BusinessRecordRow[]>([]);
  // Excel 式表头筛选(TanStack columnFilters)。
  // 初始值:状态默认排除已作废 + URL 深链(台账叶科目跳转:?subjectId=xx&year=yyyy)。
  // 单列排序(§Q4:后点覆盖;不持久化;取消=回到服务端默认序:业务发生日期降序)。
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() => {
    const init: ColumnFiltersState = [
      { id: 'status', value: ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID'] },
    ];
    const sid = search.get('subjectId');
    if (sid) init.push({ id: 'subjectId', value: [sid] });
    const y = search.get('year');
    const n = y ? Number(y) : NaN;
    if (Number.isInteger(n) && n >= 1900 && n <= 9999) init.push({ id: 'budgetYear', value: [n] });
    return init;
  });
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
  // 报销凭证附件 Sheet(Task 9 集成)。
  const [attachmentTarget, setAttachmentTarget] = useState<BusinessRecordRow | null>(null);
  // 按科目层级打包附件 Dialog(Task 5 集成)。
  const [packageOpen, setPackageOpen] = useState(false);
  // 批量选择(勾选行 → 批量作废);仅记录可写者渲染勾选列。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchVoidOpen, setBatchVoidOpen] = useState(false);
  // 表单内待上传附件(Task 10:不进 zod schema,业务保存成功后循环上传)。
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  const form = useForm<RecordFormValues>({
    resolver: zodResolver(recordSchema),
    defaultValues: {
      budgetYear: new Date().getFullYear(),
      status: 'PLACEHOLDER',
      handler: '',
      summary: '',
      docNo: '',
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

  /** 全量拉取(含作废;表头筛选全部在客户端,Excel 式即时过滤)。 */
  const reloadRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const data = await apiFetch<{ records: BusinessRecordRow[] }>(
        `/api/projects/${projectId}/records?includeVoid=1`,
      );
      setRecords(data.records ?? []);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setLoadingRecords(false);
    }
  }, [projectId]);

  // 拉取业务记录(随筛选变化重拉;筛选事件已重置 loading,此处只发请求)。
  useEffect(() => {
    // 数据拉取是 effect 的合法用途;setState 均在 Promise 回调中。
    void reloadRecords();
  }, [reloadRecords]);

  /** 打开"新增"Dialog。 */
  const openCreate = () => {
    setEditing(null);
    setPendingFiles([]);
    form.reset({
      budgetYear: new Date().getFullYear(),
      subjectId: undefined,
      amount: undefined,
      businessDate: new Date(),
      handler: '',
      summary: '',
      status: 'PLACEHOLDER',
      docNo: '',
      remark: '',
    });
    setFormOpen(true);
  };

  /** 打开"修改"Dialog,预填当前行。 */
  const openEdit = (row: BusinessRecordRow) => {
    setEditing(row);
    setPendingFiles([]);
    form.reset({
      budgetYear: row.budgetYear,
      subjectId: row.subjectId,
      amount: row.amount,
      businessDate: new Date(row.businessDate),
      handler: row.handler,
      summary: row.summary,
      status: row.status,
      docNo: row.docNo ?? '',
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
        docNo: values.docNo || null,
        remark: values.remark || null,
      };
      setSubmitting(true);
      try {
        let savedRecordId = editing?.id ?? '';
        /** 疑似重复提示(ADR 0002):指纹命中既有记录,仅警示不阻断。 */
        const hintDup = (
          hints: Array<{ businessDate: string; amount: string; summary: string }>,
        ) => {
          const c = hints[0];
          if (c)
            toast.warning(
              `疑似重复:与 ${c.businessDate} 的 ${c.amount} 元「${c.summary}」相似,请确认是否两笔`,
            );
        };
        if (editing) {
          const res = await apiFetch<{
            record: BusinessRecordRow;
            overBudget: boolean;
            duplicateHints?: Array<{ businessDate: string; amount: string; summary: string }>;
          }>(`/api/projects/${projectId}/records/${editing.id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
          toast.success('已保存修改');
          if (res.overBudget) setOverBudgetOpen(true);
          if (res.duplicateHints?.length) hintDup(res.duplicateHints);
          setFormOpen(false);
        } else {
          const res = await apiFetch<{
            record: BusinessRecordRow;
            overBudget: boolean;
            duplicateHints?: Array<{ businessDate: string; amount: string; summary: string }>;
          }>(`/api/projects/${projectId}/records`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          toast.success('已新增业务记录');
          if (res.overBudget) setOverBudgetOpen(true);
          if (res.duplicateHints?.length) hintDup(res.duplicateHints);
          savedRecordId = res.record.id;
          if (keepOpen) {
            form.reset({
              budgetYear: values.budgetYear,
              subjectId: values.subjectId,
              amount: undefined,
              businessDate: values.businessDate,
              handler: values.handler,
              summary: '',
              status: values.status,
              docNo: '',
              remark: '',
            });
            form.setFocus('amount');
          } else {
            setFormOpen(false);
          }
        }

        // —— 附件:业务已保存成功后,循环上传 pendingFiles。失败不回滚业务(解耦)。 ——
        if (pendingFiles.length > 0 && savedRecordId) {
          const failed: string[] = [];
          for (const file of pendingFiles) {
            try {
              await uploadAttachment(projectId, savedRecordId, file);
            } catch {
              failed.push(file.name);
            }
          }
          if (failed.length === 0) {
            toast.success(`已上传 ${pendingFiles.length} 个附件`);
          } else {
            toast.error(
              `业务已保存,但 ${failed.length} 个附件上传失败:${failed.join(', ')}(可在附件抽屉重试)`,
            );
          }
          setPendingFiles([]);
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

  /** 提交批量作废(勾选行共用同一原因;已作废行服务端自动跳过)。 */
  const submitBatchVoid = async () => {
    const ids = visibleVoidableIds.filter((id) => selectedIds.has(id));
    if (ids.length === 0) return;
    const reason = voidReason.trim();
    if (!reason) {
      setVoidError('请填写作废原因');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch<{ voided: number; skipped: number }>(
        `/api/projects/${projectId}/records/void-batch`,
        { method: 'POST', body: JSON.stringify({ recordIds: ids, reason }) },
      );
      toast.success(
        res.skipped > 0
          ? `已作废 ${res.voided} 条,跳过 ${res.skipped} 条已作废`
          : `已批量作废 ${res.voided} 条`,
      );
      setBatchVoidOpen(false);
      setVoidReason('');
      setVoidError(null);
      setSelectedIds(new Set());
      await reloadRecords();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
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

  // subjectMap 同步更新为 HeaderFilter 的 valueLabels(subjectId → 科目名)。
  const subjectLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of leafSubjects) m[s.subjectId] = s.name;
    return m;
  }, [leafSubjects]);

  /** 新增记录科目下拉选项:默认只显示名称;存在同名叶科目时追加编号消歧(防记错科目)。 */
  const subjectSelectOptions = useMemo(() => {
    const nameCount = new Map<string, number>();
    for (const s of leafSubjects) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
    return leafSubjects.map((s) => ({
      value: s.subjectId,
      label: (nameCount.get(s.name) ?? 0) > 1 ? `${s.name}（${s.code}）` : s.name,
      keywords: s.code,
    }));
  }, [leafSubjects]);

  /** 科目/年度列的稳定候选(不受本列筛选影响)。 */
  const subjectOptions = useMemo(() => leafSubjects.map((s) => s.subjectId), [leafSubjects]);
  const yearOptions = useMemo(
    () => Array.from(new Set(records.map((r) => r.budgetYear))).sort((a, b) => b - a),
    [records],
  );

  /**
   * 从 TanStack columnFilters 派生当前生效的年度/科目筛选(用于"导出附件 zip",
   * 让导出与表头所见一致)。表头筛选是清单形态(number[]/string[]),导出 API 只接受
   * 单值,故仅在「恰好选中一个」时取该值传入;多选或未选时传 undefined,
   * 导出 API 收到 undefined 即回退为「全部年度/全部科目」(不限筛选)。
   */
  const activeYear = (() => {
    const f = columnFilters.find((c) => c.id === 'budgetYear');
    const v = f?.value;
    return Array.isArray(v) && v.length === 1 ? Number(v[0]) : undefined;
  })();
  const activeSubjectId = (() => {
    const f = columnFilters.find((c) => c.id === 'subjectId');
    const v = f?.value;
    return Array.isArray(v) && v.length === 1 ? String(v[0]) : undefined;
  })();

  /** 行内操作:修改/状态切换/作废(可录入者且未作废);历史全员可见。 */
  function RowActions({ row }: { row: BusinessRecordRow }) {
    return (
      <div className="flex gap-1">
        {project?.canWriteRecords ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => openEdit(row)} disabled={row.isVoid}>
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
          </>
        ) : null}
        {/* 作废是破坏性操作(record:void=OWNER/ADMIN),与批量作废入口同门控。 */}
        {project?.canEdit ? (
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
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => void openHistory(row)}>
          历史
        </Button>
      </div>
    );
  }

  // Excel 式表头筛选:列定义(values=值清单勾选,text=包含,range=金额,dateRange=日期)。
  const columns = useMemo<ColumnDef<BusinessRecordRow>[]>(
    () => [
      // 批量选择列(仅可作废者=ADMIN/OWNER 渲染;已作废行禁选)。全选作用于当前筛选可见的未作废行。
      ...(project?.canEdit
        ? [
            {
              id: 'select',
              header: ({ table: tbl }) => {
                const ids = tbl
                  .getFilteredRowModel()
                  .rows.filter((r) => !r.original.isVoid)
                  .map((r) => r.original.id);
                const sel = ids.filter((id) => selectedIds.has(id)).length;
                const all = ids.length > 0 && sel === ids.length;
                return (
                  <Checkbox
                    checked={sel > 0 && !all ? 'indeterminate' : all}
                    onCheckedChange={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
                        return next;
                      })
                    }
                    aria-label="全选可见记录"
                  />
                );
              },
              enableColumnFilter: false,
              enableSorting: false,
              cell: ({ row }) => (
                <Checkbox
                  checked={selectedIds.has(row.original.id)}
                  disabled={row.original.isVoid}
                  onCheckedChange={() =>
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(row.original.id)) next.delete(row.original.id);
                      else next.add(row.original.id);
                      return next;
                    })
                  }
                  aria-label={`选择记录:${row.original.summary}`}
                />
              ),
            } as ColumnDef<BusinessRecordRow>,
          ]
        : []),
      {
        id: 'budgetYear',
        accessorKey: 'budgetYear',
        // §codex P2:数值列 TanStack 自动首次降序;与其他列统一为首次升序。
        sortDescFirst: false,
        header: ({ column }) => (
          <HeaderFilter column={column} title="年度" type="values" options={yearOptions} sortable />
        ),
        cell: ({ row }) => <span className="tabular-nums">{row.original.budgetYear}</span>,
        filterFn: multiSelect<BusinessRecordRow>(),
      },
      {
        id: 'subjectId',
        accessorKey: 'subjectId',
        header: ({ column }) => (
          <HeaderFilter
            column={column}
            title="科目"
            type="values"
            valueLabels={subjectLabels}
            options={subjectOptions}
            sortable
          />
        ),
        cell: ({ row }) => {
          const sub = subjectMap.get(row.original.subjectId);
          return sub ? (
            sub.name
          ) : (
            <span className="font-mono text-xs text-mute">
              {row.original.subjectId.slice(0, 8)}
            </span>
          );
        },
        sortingFn: (a, b, id) =>
          (subjectMap.get(a.getValue<string>(id))?.name ?? '').localeCompare(
            subjectMap.get(b.getValue<string>(id))?.name ?? '',
            'zh-Hans-CN',
          ),
        filterFn: multiSelect<BusinessRecordRow>(),
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
        sortingFn: (a, b, id) => {
          const va = Number(a.getValue<string>(id)) || 0;
          const vb = Number(b.getValue<string>(id)) || 0;
          return va === vb ? 0 : va < vb ? -1 : 1;
        },
        filterFn: numberRange<BusinessRecordRow>(),
      },
      {
        id: 'businessDate',
        accessorKey: 'businessDate',
        header: ({ column }) => (
          <HeaderFilter column={column} title="业务发生日期" type="dateRange" sortable />
        ),
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDate(row.original.businessDate)}</span>
        ),
        filterFn: dateRange<BusinessRecordRow>(),
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
        sortingFn: (a, b, id) => {
          const label = (v: string) =>
            v === '__void__' ? '已作废' : (STATUS_LABEL[v as BusinessStatus] ?? v);
          return label(a.getValue<string>(id)).localeCompare(
            label(b.getValue<string>(id)),
            'zh-Hans-CN',
          );
        },
        filterFn: multiSelect<BusinessRecordRow>(),
      },
      {
        id: 'handler',
        accessorKey: 'handler',
        header: ({ column }) => (
          <HeaderFilter column={column} title="经办人" type="values" sortable />
        ),
        filterFn: multiSelect<BusinessRecordRow>(),
      },
      {
        id: 'docNo',
        // §codex P2:null 归一为 undefined 走 sortUndefined(方向无关,双向恒最后),
        // 避免 desc 反转 sortingFn 结果把空单据编号排到最前。
        accessorFn: (row) => row.docNo ?? undefined,
        sortUndefined: 'last',
        header: ({ column }) => (
          <HeaderFilter column={column} title="单据编号" type="text" sortable />
        ),
        cell: ({ row }) =>
          row.original.docNo ? (
            <span className="block max-w-36 truncate font-mono text-xs" title={row.original.docNo}>
              {row.original.docNo}
            </span>
          ) : (
            <span className="text-mute">—</span>
          ),
        sortingFn: (a, b, id) =>
          (a.getValue<string>(id) ?? '').localeCompare(b.getValue<string>(id) ?? ''),
        filterFn: textContains<BusinessRecordRow>(),
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
        filterFn: textContains<BusinessRecordRow>(),
      },
      {
        id: 'enteredAt',
        accessorKey: 'enteredAt',
        header: ({ column }) => (
          <HeaderFilter column={column} title="录入时间" type="dateRange" sortable />
        ),
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDateTime(row.original.enteredAt)}</span>
        ),
        filterFn: dateRange<BusinessRecordRow>(),
      },
      {
        id: 'attachments',
        header: () => '附件',
        enableColumnFilter: false,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-mute"
            onClick={() => setAttachmentTarget(row.original)}
            aria-label="查看报销凭证"
          >
            <Paperclip className="size-4" />
          </Button>
        ),
        enableSorting: false,
        enableHiding: false,
      },
      {
        id: 'actions',
        header: () => '操作',
        enableColumnFilter: false,
        cell: ({ row }) => <RowActions row={row.original} />,
      },
    ],
    [subjectLabels, yearOptions, project?.canEdit, selectedIds],
  );

  // useReactTable 与 React Compiler 记忆化假设不兼容(官方已知,功能正常)。
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: records,
    columns,
    state: { columnFilters, sorting },
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    enableSortingRemoval: true,
    enableMultiSort: false,
  });

  // 批量作废目标 = 当前筛选可见且勾选的未作废行(所见即所废,避免误伤被筛选隐藏的行)。
  const visibleVoidableIds = table
    .getRowModel()
    .rows.filter((r) => !r.original.isVoid)
    .map((r) => r.original.id);
  const selectedVisibleCount = visibleVoidableIds.filter((id) => selectedIds.has(id)).length;

  // §总计行:对当前表头筛选结果统计(所见即所总,便于筛选后直接看合计);
  // 作废记录不计入(与执行统计口径一致),有作废行混入时在标签上注明。
  const filteredRows = table.getFilteredRowModel().rows;
  let totalValidCount = 0;
  let totalVoidCount = 0;
  let amountSum = new D(0);
  for (const r of filteredRows) {
    if (r.original.isVoid) {
      totalVoidCount++;
      continue;
    }
    totalValidCount++;
    amountSum = amountSum.plus(new D(r.original.amount));
  }

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
      {/* 工具行:表头筛选说明 + 导出附件 + 新增入口(可录入者) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          点击表头 <Funnel className="inline size-3.5" /> 可按任意列筛选(勾选清单/文本/范围)。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              exportAttachmentsZip(projectId, {
                budgetYear: activeYear,
                subjectId: activeSubjectId,
              }).catch((e: unknown) => toast.error(e instanceof Error ? e.message : '导出失败'))
            }
          >
            <Package className="size-4" />
            导出附件(zip)
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPackageOpen(true)}>
            <FolderArchive className="size-4" />
            按科目打包
          </Button>
          {project?.canWriteRecords ? (
            <Button onClick={openCreate}>
              <Plus />
              新增
            </Button>
          ) : null}
          {project?.canEdit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => router.push(`/projects/${projectId}/imports`)}
            >
              <Upload />
              导入 Excel
            </Button>
          ) : null}
        </div>
      </div>

      {/* 批量操作条(有勾选时出现) */}
      {project?.canEdit && selectedVisibleCount > 0 ? (
        <div className="flex items-center justify-between rounded-lg border border-warning/40 bg-warning/20 px-4 py-2">
          <p className="text-sm">
            已勾选 <span className="font-semibold tabular-nums">{selectedVisibleCount}</span>{' '}
            条未作废记录(仅作用于当前筛选结果)
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
              取消勾选
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setVoidReason('');
                setVoidError(null);
                setBatchVoidOpen(true);
              }}
            >
              批量作废
            </Button>
          </div>
        </div>
      ) : null}

      {/* 记录表(Excel 式表头筛选) */}
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
                          ? 'w-60'
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
            {/* §总计行:首行显示当前筛选结果的笔数与金额合计(作废不计);
                用普通 tr 渲染在首行(浏览器把 tfoot 固定在底部),列序随可见列动态对齐。
                门槛 = 筛选模型有行即可(§codex P2):全部为作废时也渲染
                「总计 0 笔(作废不计)/ 0.00」,恰好在对全部行排除合计的时刻。 */}
            {!loadingRecords && filteredRows.length > 0 ? (
              <TableRow className="border-b border-border bg-muted/40 font-medium hover:bg-muted/40">
                {table.getVisibleLeafColumns().map((col, idx) => (
                  <TableCell key={col.id} className="py-1.5">
                    {col.id === 'amount' ? (
                      <span className="block text-right tabular-nums">{amountSum.toFixed(2)}</span>
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
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={10}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={10} className="h-32 text-center text-muted-foreground">
                  暂无业务记录
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
                    <Combobox
                      options={subjectSelectOptions}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="选择叶科目"
                      searchPlaceholder="输入名称或编号筛选…"
                      emptyText="无匹配叶科目"
                    />
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
                name="docNo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>单据编号(可选)</FormLabel>
                    <FormControl>
                      <Input maxLength={64} placeholder="财务系统单据编号" {...field} />
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
              {/* 报销凭证(可选):表单提交成功后一并上传;不参与 zod 校验。 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <FormLabel>报销凭证(可选)</FormLabel>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const el = document.createElement('input');
                      el.type = 'file';
                      el.multiple = true;
                      el.accept =
                        '.jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx';
                      el.onchange = () => {
                        if (el.files)
                          setPendingFiles((prev) => [...prev, ...Array.from(el.files!)]);
                      };
                      el.click();
                    }}
                  >
                    选择文件
                  </Button>
                </div>
                {pendingFiles.length === 0 ? (
                  <p className="text-xs text-mute">未选择附件;保存业务后将一并上传</p>
                ) : (
                  <ul className="space-y-1 rounded-md border border-hairline bg-card p-2">
                    {pendingFiles.map((f, i) => (
                      <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm">
                        <Paperclip className="size-3.5 shrink-0 text-mute" />
                        <span className="flex-1 truncate" title={f.name}>
                          {f.name}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          onClick={() =>
                            setPendingFiles((prev) => prev.filter((_, idx) => idx !== i))
                          }
                        >
                          ×
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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

      {/* 作废 Dialog(单条/批量共用;原因必填,原生受控 textarea) */}
      <Dialog
        open={voidTarget !== null || batchVoidOpen}
        onOpenChange={(open) => {
          if (!open) {
            setVoidTarget(null);
            setBatchVoidOpen(false);
            setVoidReason('');
            setVoidError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {batchVoidOpen ? `批量作废 ${selectedVisibleCount} 条业务记录` : '作废业务记录'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {voidTarget ? (
              <Alert variant="warning">
                <AlertTitle>
                  将作废记录:{formatDate(voidTarget.businessDate)} ·{' '}
                  {subjectMap.get(voidTarget.subjectId)?.name ?? ''} · {voidTarget.summary}
                </AlertTitle>
                <AlertDescription>作废后该记录占用将由台账实时解除,不可恢复。</AlertDescription>
              </Alert>
            ) : (
              <Alert variant="warning">
                <AlertTitle>
                  将作废当前勾选的 {selectedVisibleCount} 条记录(已作废记录自动跳过)。
                </AlertTitle>
                <AlertDescription>
                  作废后记录占用由台账实时解除,不可恢复;作废原因将写入全部记录的历史。
                </AlertDescription>
              </Alert>
            )}
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
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setVoidTarget(null);
                setBatchVoidOpen(false);
                setVoidReason('');
                setVoidError(null);
              }}
              disabled={submitting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void (batchVoidOpen ? submitBatchVoid() : submitVoid())}
              disabled={submitting}
            >
              {submitting ? '提交中…' : batchVoidOpen ? '确认批量作废' : '确认作废'}
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

      {/* 报销凭证附件 Sheet(Task 9 集成) */}
      <AttachmentSheet
        projectId={projectId}
        record={
          attachmentTarget
            ? {
                id: attachmentTarget.id,
                summary: attachmentTarget.summary,
                handler: attachmentTarget.handler,
                amount: attachmentTarget.amount,
                businessDate: attachmentTarget.businessDate,
                isVoid: attachmentTarget.isVoid,
              }
            : null
        }
        canWrite={!!project?.canWriteRecords}
        open={!!attachmentTarget}
        onOpenChange={(o) => !o && setAttachmentTarget(null)}
      />

      {/* 按科目层级打包附件 Dialog(Task 5 集成) */}
      <PackageAttachmentsDialog
        projectId={projectId}
        yearOptions={yearOptions}
        open={packageOpen}
        onOpenChange={setPackageOpen}
      />
    </div>
  );
}

export default function BusinessRecordsPage() {
  // useSearchParams 需在 Suspense 边界内(台账页叶科目跳转带入 ?subjectId=&year= 初值)。
  return (
    <Suspense
      fallback={
        <div className="space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <BusinessRecordsPageInner />
    </Suspense>
  );
}
