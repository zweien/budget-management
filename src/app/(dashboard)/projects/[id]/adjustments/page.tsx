'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch, downloadFile } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
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
import { EmptyState } from '@/components/layout/empty-state';
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

// ------------------------------------------------------------
// 枚举(本地定义,不引 @prisma/client)。
// ------------------------------------------------------------
const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
};

/** Badge 语义色遵循 DESIGN.md。 */
const STATUS_BADGE: Record<string, 'secondary' | 'warning' | 'success' | 'error' | 'outline'> = {
  DRAFT: 'secondary',
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  WITHDRAWN: 'outline',
};

// ------------------------------------------------------------
// 类型
// ------------------------------------------------------------
interface ProjectDetail {
  id: string;
  code: string;
  name: string;
  /** 服务端随详情下发:当前用户是否可编辑该项目(查看态门控)。 */
  canEdit?: boolean;
}

interface InitialBudgetState {
  id?: string;
  status?: string;
}

/** 科目预算基线(原总预算 + 原年度预算)。 */
interface SubjectBaseline {
  subjectId: string;
  code: string;
  name: string;
  totalCurrent: string;
  annualCurrent: string;
}

interface BaselineResponse {
  year: number;
  baseline: SubjectBaseline[];
}

/** 调整明细行(对应后端 BudgetAdjustmentLine)。 */
interface AdjustmentLine {
  id: string;
  year: number;
  subjectId: string | null;
  totalAdjustment: string;
  annualAdjustment: string;
  newSubjectName?: string | null;
  newSubjectParentId?: string | null;
}

/** 调整单。 */
interface AdjustmentRow {
  id: string;
  year: number;
  status: string;
  totalReason: string | null;
  annualReason: string | null;
  applicantId: string;
  createdAt: string;
  lines: AdjustmentLine[];
}

interface ListResponse {
  adjustments: AdjustmentRow[];
}

/** 表单内的明细编辑行。 */
interface EditLine {
  key: string;
  subjectId: string | null;
  // 新增科目模式(isNew=true 时):name + 父节点。
  isNew: boolean;
  newName: string;
  newParentId: string | null;
  totalAdjustment: string;
  annualAdjustment: string;
}

/** 科目树节点(用于父节点下拉)。 */
interface SubjectNode {
  id: string;
  name: string;
  parentId: string | null;
  level: number;
  isLeaf: boolean;
}

let keySeq = 0;
const genKey = () => `line-${++keySeq}`;

/** 新增科目 Select 哨兵值。 */
const NEW_SUBJECT = '__NEW__';

function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

function formatDateTime(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm');
}

/** 字符串金额 → 显示带正负号(用于明细摘要)。 */
function signedAmount(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

const emptyLine = (): EditLine => ({
  key: genKey(),
  subjectId: null,
  isNew: false,
  newName: '',
  newParentId: null,
  totalAdjustment: '',
  annualAdjustment: '',
});

export default function AdjustmentsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [budgetStatus, setBudgetStatus] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<AdjustmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  // 列表 / 表单 视图切换。
  const [mode, setMode] = useState<'list' | 'form'>('list');

  // 表单状态。
  const [formYear, setFormYear] = useState<number>(() => new Date().getFullYear());
  const [baseline, setBaseline] = useState<SubjectBaseline[]>([]);
  const [formLines, setFormLines] = useState<EditLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 科目全树(用于新增科目的父节点下拉,只取非叶)。
  const [subjectTree, setSubjectTree] = useState<SubjectNode[]>([]);
  // 调整原因:原生受控 textarea(React 受控原生元素无中文输入法问题,
  // 历史问题源于 antd TextArea 的内部重格式化)。
  const [totalReason, setTotalReason] = useState('');
  const [annualReason, setAnnualReason] = useState('');

  // 只读明细 Sheet。
  const [detailTarget, setDetailTarget] = useState<AdjustmentRow | null>(null);
  // 删除确认。
  const [deleteTarget, setDeleteTarget] = useState<AdjustmentRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  /** 初始预算是否已生效(发起调整的前提)。 */
  const isEffective = budgetStatus === 'APPROVED';

  const baselineMap = useMemo(() => new Map(baseline.map((b) => [b.subjectId, b])), [baseline]);

  const subjectName = (subjectId: string | null): string => {
    if (!subjectId) return '—';
    return baselineMap.get(subjectId)?.name ?? subjectId.slice(0, 8);
  };

  // 拉取项目头 + 初始预算状态(仅一次)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [proj, budget] = await Promise.all([
          apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
          apiFetch<InitialBudgetState | null>(`/api/projects/${projectId}/initial-budget`).catch(
            () => null,
          ),
        ]);
        if (cancelled) return;
        setProject(proj);
        setBudgetStatus(budget?.status ?? null);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '加载项目信息失败';
          setFatal(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 拉取调整单列表。
  const reload = async () => {
    try {
      const [listRes, baseRes] = await Promise.all([
        apiFetch<ListResponse>(`/api/projects/${projectId}/adjustments`),
        // 拉一次科目基线(任意年度),用于列表/明细里 subjectId → 科目名称。
        apiFetch<BaselineResponse>(
          `/api/projects/${projectId}/adjustments/baseline?year=${new Date().getFullYear()}`,
        ).catch(() => null),
      ]);
      setAdjustments(listRes.adjustments);
      if (baseRes && baseline.length === 0) {
        setBaseline(baseRes.baseline);
      }
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reload();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 拉取某年度的科目预算基线(原总预算 + 原年度预算)。
  const loadBaseline = async (year: number) => {
    setBaselineLoading(true);
    try {
      const { baseline: b } = await apiFetch<BaselineResponse>(
        `/api/projects/${projectId}/adjustments/baseline?year=${year}`,
      );
      setBaseline(b);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setBaselineLoading(false);
    }
  };

  // 拉取科目全树(用于新增科目的父节点下拉)。
  const loadSubjectTree = async () => {
    try {
      const { subjects } = await apiFetch<{ subjects: SubjectNode[] }>(
        `/api/projects/${projectId}/subjects`,
      );
      setSubjectTree(subjects);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  };

  /** 父节点候选:非叶科目,带层级缩进显示。 */
  const parentOptions = useMemo(
    () =>
      // 防御:level 异常(如历史 PATCH 写坏的 0)时不崩页,repeat 负数会抛 RangeError。
      subjectTree
        .filter((s) => !s.isLeaf)
        .map((s) => ({ value: s.id, label: `${'　'.repeat(Math.max(0, s.level - 1))}${s.name}` })),
    [subjectTree],
  );

  // ------------------------------------------------------------
  // 表单操作
  // ------------------------------------------------------------
  const openCreate = async () => {
    setEditingId(null);
    const y = new Date().getFullYear();
    setFormYear(y);
    setTotalReason('');
    setAnnualReason('');
    await Promise.all([loadBaseline(y), loadSubjectTree()]);
    setFormLines([emptyLine()]);
    setMode('form');
  };

  const openEdit = async (row: AdjustmentRow) => {
    setEditingId(row.id);
    setFormYear(row.year);
    setTotalReason(row.totalReason ?? '');
    setAnnualReason(row.annualReason ?? '');
    await Promise.all([loadBaseline(row.year), loadSubjectTree()]);
    setFormLines(
      row.lines.map((l) => ({
        key: genKey(),
        subjectId: l.subjectId,
        isNew: !l.subjectId,
        newName: l.newSubjectName ?? '',
        newParentId: l.newSubjectParentId ?? null,
        totalAdjustment: l.totalAdjustment,
        annualAdjustment: l.annualAdjustment,
      })),
    );
    setMode('form');
  };

  const cancelForm = () => {
    setMode('list');
    setEditingId(null);
  };

  const updateLine = (key: string, patch: Partial<EditLine>) => {
    setFormLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    setFormLines((prev) => [...prev, emptyLine()]);
  };

  const removeLine = (key: string) => {
    setFormLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  };

  const handleYearChange = async (y: number) => {
    setFormYear(y);
    await loadBaseline(y);
  };

  /**
   * 构建并校验 payload。
   * @param requireBalance 是否强制双维度收支平衡(草稿=false,提交=true)。
   *   草稿允许不平衡、允许调整额留空(留空按 0 处理),便于保存中间态。
   */
  const buildPayload = (
    requireBalance: boolean,
  ): { ok: boolean; payload?: unknown; error?: string } => {
    // 有效行:现有科目(subjectId)或新增科目(isNew 且 newName+newParentId 齐备)。
    const valid = formLines.filter(
      (l) => l.subjectId || (l.isNew && l.newName.trim() && l.newParentId),
    );
    if (valid.length === 0) {
      return { ok: false, error: '请至少选择一个科目或新增科目' };
    }
    const sumField = (sel: 'totalAdjustment' | 'annualAdjustment') =>
      valid.reduce((a, l) => a + (Number(l[sel]) || 0), 0);
    if (requireBalance) {
      // 提交时:每行调整额必须明确填写(可填 0)。
      for (const l of valid) {
        if (l.totalAdjustment === '' || l.annualAdjustment === '') {
          return { ok: false, error: '每行的「总预算调整额」「年度调整额」都需填写(可填 0)' };
        }
      }
      const totalSum = sumField('totalAdjustment');
      const annualSum = sumField('annualAdjustment');
      if (Math.abs(totalSum) > 0.001) {
        return { ok: false, error: `总预算维度调整不平衡:合计 ${totalSum.toFixed(2)} ≠ 0` };
      }
      if (Math.abs(annualSum) > 0.001) {
        return { ok: false, error: `年度预算维度调整不平衡:合计 ${annualSum.toFixed(2)} ≠ 0` };
      }
    }
    const lines = valid.map((l) => {
      const base = {
        // 草稿允许留空,按 0 落库;提交时已保证非空。
        totalAdjustment: l.totalAdjustment === '' ? '0' : Number(l.totalAdjustment).toFixed(2),
        annualAdjustment: l.annualAdjustment === '' ? '0' : Number(l.annualAdjustment).toFixed(2),
      };
      if (l.isNew) {
        return {
          ...base,
          subjectId: null,
          newSubjectName: l.newName.trim(),
          newSubjectParentId: l.newParentId,
        };
      }
      return { ...base, subjectId: l.subjectId };
    });
    return {
      ok: true,
      payload: {
        year: formYear,
        totalReason: totalReason.trim() || null,
        annualReason: annualReason.trim() || null,
        lines,
      },
    };
  };

  const handleSaveDraft = async () => {
    // 草稿:不校验平衡,允许保存未完成的中间态。
    const { ok, payload, error } = buildPayload(false);
    if (!ok) {
      toast.warning(error);
      return;
    }
    setSubmitting(true);
    try {
      if (editingId) {
        await apiFetch(`/api/projects/${projectId}/adjustments/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch(`/api/projects/${projectId}/adjustments`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      toast.success('已保存草稿');
      setMode('list');
      setEditingId(null);
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAndSubmit = async () => {
    // 提交:强制双维度收支平衡。
    const { ok, payload, error } = buildPayload(true);
    if (!ok) {
      toast.warning(error);
      return;
    }
    setSubmitting(true);
    try {
      const { adjustment } = await apiFetch<{ adjustment: AdjustmentRow }>(
        `/api/projects/${projectId}/adjustments`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      await apiFetch(`/api/projects/${projectId}/adjustments/${adjustment.id}/submit`, {
        method: 'POST',
      });
      toast.success('已提交审批,可在审批中心查看进度');
      setMode('list');
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitRow = async (row: AdjustmentRow) => {
    try {
      await apiFetch(`/api/projects/${projectId}/adjustments/${row.id}/submit`, {
        method: 'POST',
      });
      toast.success('已提交审批');
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/projects/${projectId}/adjustments/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      toast.success('已删除草稿');
      setDeleteTarget(null);
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setDeleting(false);
    }
  };

  /** 导出该次调整为 docx(按模板填充)。dim=total 总预算维度 / annual 年度维度。 */
  const exportDocx = async (row: AdjustmentRow, dim: 'total' | 'annual') => {
    setExporting(true);
    try {
      await downloadFile(
        `/api/projects/${projectId}/adjustments/${row.id}/export?dim=${dim}`,
        dim === 'total' ? '总预算调整.docx' : '年度预算调整.docx',
      );
      toast.success('已开始下载');
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  // ------------------------------------------------------------
  // 自动生成调整原因说明
  // ------------------------------------------------------------
  /** 元字符串 → 万元去尾零(0.5、5、1.2),用于原因文本的自然语言金额。 */
  function yuanToWanTrim(yuanStr: string): string {
    const n = Number(yuanStr) / 10000;
    if (!Number.isFinite(n) || n === 0) return '0';
    // 去尾零:toFixed(2) 后剥末尾 0 和多余小数点。
    return Number(n.toFixed(2)).toString();
  }

  /**
   * 按维度生成调整原因说明。
   * 规则:逐品名(明细行)描述,原预算为0的调增用"新增",否则用"调增/调减";
   * 金额用万元去尾零;该维度无任何调整(全0或无行)→ 返回空串。
   */
  const generateReason = (dim: 'total' | 'annual'): string => {
    const field = dim === 'total' ? 'totalAdjustment' : 'annualAdjustment';
    const parts: string[] = [];
    for (const l of formLines) {
      const amt = Number(l[field]) || 0;
      if (amt === 0) continue; // 该维度此行无调整
      const wan = yuanToWanTrim(l[field]);
      // 新增科目行:原预算必为 0,调增即"新增"。
      if (l.isNew) {
        const name = l.newName.trim() || '新科目';
        if (amt > 0) {
          parts.push(`新增${name}预算${wan}万元`);
        } else {
          parts.push(`${name}预算调减${Math.abs(Number(wan))}万元`);
        }
        continue;
      }
      if (!l.subjectId) continue;
      const base = baselineMap.get(l.subjectId);
      const productName = base?.name ?? '';
      const originCurrent =
        dim === 'total' ? Number(base?.totalCurrent ?? 0) : Number(base?.annualCurrent ?? 0);
      if (amt > 0 && originCurrent === 0) {
        parts.push(`新增${productName}预算${wan}万元`);
      } else if (amt > 0) {
        parts.push(`${productName}预算调增${wan}万元`);
      } else {
        parts.push(`${productName}预算调减${Math.abs(Number(wan))}万元`);
      }
    }
    if (parts.length === 0) return '';
    return `根据项目研究需要，对经费预算进行调整。${parts.join('，')}。`;
  };

  /** 一键生成两个维度原因(覆盖现有内容)。 */
  const handleAutoGenerate = () => {
    const t = generateReason('total');
    const a = generateReason('annual');
    setTotalReason(t);
    setAnnualReason(a);
    toast.success(t || a ? '已生成调整原因说明,可继续编辑' : '当前调整无变动,未生成说明');
  };

  // ------------------------------------------------------------
  // 汇总(实时平衡校验)
  // ------------------------------------------------------------
  const summary = useMemo(() => {
    const sumField = (sel: 'totalAdjustment' | 'annualAdjustment') =>
      formLines.reduce((a, l) => a + (Number(l[sel]) || 0), 0);
    const totalSum = sumField('totalAdjustment');
    const annualSum = sumField('annualAdjustment');
    return {
      totalSum,
      annualSum,
      balanced: Math.abs(totalSum) < 0.001 && Math.abs(annualSum) < 0.001,
    };
  }, [formLines]);

  // ------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (fatal || !project) {
    return (
      <Alert variant="error">
        <AlertTitle>加载失败</AlertTitle>
        <AlertDescription>{fatal}</AlertDescription>
      </Alert>
    );
  }

  // ============== 表单视图 ==============
  if (mode === 'form') {
    /** 计算调整后值 = 原 + 调整额。 */
    const afterTotal = (r: EditLine): string => {
      const base = r.subjectId ? Number(baselineMap.get(r.subjectId)?.totalCurrent ?? 0) : 0;
      const adj = Number(r.totalAdjustment) || 0;
      return (base + adj).toFixed(2);
    };
    const afterAnnual = (r: EditLine): string => {
      const base = r.subjectId ? Number(baselineMap.get(r.subjectId)?.annualCurrent ?? 0) : 0;
      const adj = Number(r.annualAdjustment) || 0;
      return (base + adj).toFixed(2);
    };

    const sumOrigTotal = formLines.reduce(
      (a, l) => a + (l.isNew ? 0 : Number(baselineMap.get(l.subjectId ?? '')?.totalCurrent ?? 0)),
      0,
    );
    const sumOrigAnnual = formLines.reduce(
      (a, l) => a + (l.isNew ? 0 : Number(baselineMap.get(l.subjectId ?? '')?.annualCurrent ?? 0)),
      0,
    );

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-[-0.3px]">
            {editingId ? '编辑调整单' : '发起预算调整'}
          </h2>
          <Button variant="outline" onClick={cancelForm}>
            取消
          </Button>
        </div>

        {project.canEdit === false && (
          <Alert variant="info">
            <AlertDescription>
              你只有查看权限,表单不可保存。如需编辑,请联系管理员将你设为该项目负责人。
            </AlertDescription>
          </Alert>
        )}

        {/* 年度 + 原因(原生受控 textarea,无输入法问题) */}
        <div className="grid gap-4 rounded-lg border border-border bg-card p-4 shadow-l2 lg:grid-cols-[200px_1fr]">
          <div className="grid content-start gap-1.5">
            <Label>调整年度</Label>
            <Select
              value={String(formYear)}
              onValueChange={(v) => void handleYearChange(Number(v))}
              disabled={baselineLoading}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y} 年
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label>调整原因</Label>
              <Button variant="outline" size="sm" onClick={handleAutoGenerate}>
                <Sparkles />
                自动生成原因说明
              </Button>
              <span className="text-xs text-mute">根据当前调整明细自动生成,生成后可手动编辑</span>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs font-normal text-muted-foreground">总预算调整原因</Label>
              <Textarea
                className="min-h-14 resize-y"
                placeholder="总预算调整原因说明(导出总预算调整文档用)"
                value={totalReason}
                onChange={(e) => setTotalReason(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs font-normal text-muted-foreground">年度预算调整原因</Label>
              <Textarea
                className="min-h-14 resize-y"
                placeholder="年度预算调整原因说明(导出年度预算调整文档用)"
                value={annualReason}
                onChange={(e) => setAnnualReason(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* 调整明细 */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">调整明细</h3>
          <Button variant="outline" size="sm" onClick={addLine}>
            <Plus />
            新增科目行
          </Button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="min-w-52">科目</TableHead>
                <TableHead className="w-28 text-right">原总预算</TableHead>
                <TableHead className="w-32">总预算调整额</TableHead>
                <TableHead className="w-32 text-right">调整后总预算</TableHead>
                <TableHead className="w-28 text-right">原年度预算</TableHead>
                <TableHead className="w-32">年度调整额</TableHead>
                <TableHead className="w-32 text-right">调整后年度预算</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {formLines.map((r) => (
                <TableRow key={r.key} className="hover:bg-transparent">
                  <TableCell>
                    {r.isNew ? (
                      <div className="grid min-w-48 gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="warning">新</Badge>
                          <input
                            className="h-7 w-full min-w-24 rounded-md border border-input bg-card px-2 text-sm outline-none placeholder:text-mute focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                            placeholder="新科目名称"
                            value={r.newName}
                            onChange={(e) => updateLine(r.key, { newName: e.target.value })}
                          />
                        </div>
                        <Select
                          value={r.newParentId ?? undefined}
                          onValueChange={(v) => updateLine(r.key, { newParentId: v })}
                        >
                          <SelectTrigger size="sm" className="w-full">
                            <SelectValue placeholder="选择父节点(非叶)" />
                          </SelectTrigger>
                          <SelectContent>
                            {parentOptions.map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : (
                      <Select
                        value={r.subjectId ?? undefined}
                        onValueChange={(v) => {
                          if (v === NEW_SUBJECT) {
                            updateLine(r.key, { isNew: true, subjectId: null });
                          } else {
                            updateLine(r.key, { subjectId: v });
                          }
                        }}
                      >
                        <SelectTrigger size="sm" className="w-full min-w-40">
                          <SelectValue placeholder="选择科目" />
                        </SelectTrigger>
                        <SelectContent>
                          {baseline.map((s) => (
                            <SelectItem key={s.subjectId} value={s.subjectId}>
                              {s.name}
                            </SelectItem>
                          ))}
                          <SelectItem value={NEW_SUBJECT}>➕ 新增科目...</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {r.isNew
                      ? '0.00'
                      : r.subjectId
                        ? (baselineMap.get(r.subjectId)?.totalCurrent ?? '0.00')
                        : '—'}
                  </TableCell>
                  <TableCell>
                    <AmountInput
                      size="sm"
                      allowNegative
                      value={r.totalAdjustment}
                      onChange={(v) => updateLine(r.key, { totalAdjustment: v ?? '' })}
                    />
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {r.isNew
                      ? (Number(r.totalAdjustment) || 0).toFixed(2)
                      : r.subjectId
                        ? afterTotal(r)
                        : '—'}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {r.isNew
                      ? '0.00'
                      : r.subjectId
                        ? (baselineMap.get(r.subjectId)?.annualCurrent ?? '0.00')
                        : '—'}
                  </TableCell>
                  <TableCell>
                    <AmountInput
                      size="sm"
                      allowNegative
                      value={r.annualAdjustment}
                      onChange={(v) => updateLine(r.key, { annualAdjustment: v ?? '' })}
                    />
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {r.isNew
                      ? (Number(r.annualAdjustment) || 0).toFixed(2)
                      : r.subjectId
                        ? afterAnnual(r)
                        : '—'}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-mute hover:text-error-deep"
                      aria-label="删除该行"
                      onClick={() => removeLine(r.key)}
                      disabled={formLines.length <= 1}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell className="font-semibold">合计</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {sumOrigTotal.toFixed(2)}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right font-semibold tabular-nums',
                    Math.abs(summary.totalSum) > 0.001 && 'text-error-deep',
                  )}
                >
                  {summary.totalSum.toFixed(2)}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {(sumOrigTotal + summary.totalSum).toFixed(2)}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {sumOrigAnnual.toFixed(2)}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right font-semibold tabular-nums',
                    Math.abs(summary.annualSum) > 0.001 && 'text-error-deep',
                  )}
                >
                  {summary.annualSum.toFixed(2)}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {(sumOrigAnnual + summary.annualSum).toFixed(2)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>

        <Alert variant={summary.balanced ? 'success' : 'error'}>
          <AlertDescription>
            汇总:总预算调整合计{' '}
            <MoneyText
              value={summary.totalSum.toFixed(2)}
              riskOnNegative={false}
              className="inline"
            />{' '}
            · 年度调整合计{' '}
            <MoneyText
              value={summary.annualSum.toFixed(2)}
              riskOnNegative={false}
              className="inline"
            />
            {summary.balanced
              ? ' · 两维度均已平衡 ✓ 可提交'
              : ' · 调整合计须为 0 才可提交(原预算=调整后预算)'}
          </AlertDescription>
        </Alert>

        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={submitting || project.canEdit === false}
            onClick={handleSaveDraft}
          >
            保存草稿
          </Button>
          <Button disabled={submitting || project.canEdit === false} onClick={handleSaveAndSubmit}>
            {submitting ? '提交中…' : '保存并提交'}
          </Button>
          <Button variant="ghost" onClick={cancelForm}>
            取消
          </Button>
        </div>
      </div>
    );
  }

  // ============== 列表视图 ==============
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-[-0.3px]">调整单列表</h2>
        <Button
          onClick={() => void openCreate()}
          disabled={!isEffective || project?.canEdit === false}
          title={project?.canEdit === false ? '你只有查看权限' : undefined}
        >
          <Plus />
          发起调整
        </Button>
      </div>

      {!isEffective && (
        <Alert variant="warning">
          <AlertTitle>初始预算尚未生效,暂无法发起预算调整</AlertTitle>
          <AlertDescription>请先完成初始预算编制并审批通过,再进行预算调整。</AlertDescription>
        </Alert>
      )}

      {adjustments.length === 0 ? (
        <EmptyState title={isEffective ? '暂无调整单,点击「发起调整」' : '暂无调整单'} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-20">年度</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead>明细摘要</TableHead>
                <TableHead>原因</TableHead>
                <TableHead className="w-40">创建时间</TableHead>
                <TableHead className="w-80">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjustments.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="tabular-nums">{row.year}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[row.status] ?? 'secondary'}>
                      {STATUS_LABEL[row.status] ?? row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {!row.lines?.length ? (
                      <span className="text-mute">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {row.lines.slice(0, 2).map((l) => (
                          <span key={l.id}>
                            <span className="font-medium">{subjectName(l.subjectId)}</span>
                            <span className="text-muted-foreground tabular-nums">
                              {' '}
                              总{signedAmount(l.totalAdjustment)} 年
                              {signedAmount(l.annualAdjustment)}
                            </span>
                          </span>
                        ))}
                        {row.lines.length > 2 && (
                          <span className="text-mute">+{row.lines.length - 2} 行</span>
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-48 truncate"
                    title={[
                      row.totalReason && `总:${row.totalReason}`,
                      row.annualReason && `年:${row.annualReason}`,
                    ]
                      .filter(Boolean)
                      .join(' / ')}
                  >
                    {row.totalReason || row.annualReason ? (
                      <span className="text-sm">
                        {[
                          row.totalReason && `总:${row.totalReason}`,
                          row.annualReason && `年:${row.annualReason}`,
                        ]
                          .filter(Boolean)
                          .join(' / ')}
                      </span>
                    ) : (
                      <span className="text-mute">—</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatDateTime(row.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.status === 'DRAFT' && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => void openEdit(row)}>
                            编辑
                          </Button>
                          <Button size="sm" onClick={() => void submitRow(row)}>
                            提交审批
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-error-deep hover:bg-error-soft"
                            onClick={() => setDeleteTarget(row)}
                          >
                            删除
                          </Button>
                        </>
                      )}
                      {row.status === 'PENDING' && (
                        <span className="px-2 text-sm text-mute">审批中</span>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => setDetailTarget(row)}>
                        明细
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={exporting}
                        onClick={() => void exportDocx(row, 'total')}
                      >
                        导出总预算
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={exporting}
                        onClick={() => void exportDocx(row, 'annual')}
                      >
                        导出年度
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 删除确认 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除调整草稿</AlertDialogTitle>
            <AlertDialogDescription>确认删除该调整草稿?此操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 只读明细 Sheet */}
      <Sheet open={!!detailTarget} onOpenChange={(open) => !open && setDetailTarget(null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-6 sm:max-w-xl">
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>调整单明细</SheetTitle>
          </SheetHeader>
          {detailTarget ? (
            <div className="space-y-4">
              <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border">
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">年度</dt>
                  <dd className="mt-1 text-sm tabular-nums">{detailTarget.year}</dd>
                </div>
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">状态</dt>
                  <dd className="mt-1">
                    <Badge variant={STATUS_BADGE[detailTarget.status] ?? 'secondary'}>
                      {STATUS_LABEL[detailTarget.status] ?? detailTarget.status}
                    </Badge>
                  </dd>
                </div>
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">总预算调整原因</dt>
                  <dd className="mt-1 text-sm whitespace-pre-wrap">
                    {detailTarget.totalReason ?? <span className="text-mute">—</span>}
                  </dd>
                </div>
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">年度预算调整原因</dt>
                  <dd className="mt-1 text-sm whitespace-pre-wrap">
                    {detailTarget.annualReason ?? <span className="text-mute">—</span>}
                  </dd>
                </div>
                <div className="bg-card p-3">
                  <dt className="text-xs text-mute">创建时间</dt>
                  <dd className="mt-1 text-sm tabular-nums">
                    {formatDateTime(detailTarget.createdAt)}
                  </dd>
                </div>
              </dl>

              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>科目</TableHead>
                      <TableHead className="text-right">总预算调整</TableHead>
                      <TableHead className="text-right">年度预算调整</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detailTarget.lines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>{subjectName(l.subjectId)}</TableCell>
                        <TableCell>
                          <MoneyText value={l.totalAdjustment} riskOnNegative={false} />
                        </TableCell>
                        <TableCell>
                          <MoneyText value={l.annualAdjustment} riskOnNegative={false} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
