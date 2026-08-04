'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Modal,
  Result,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';

import { apiFetch, downloadFile } from '@/lib/api/client';
import { AmountInput } from '@/components/ui/AmountInput';
import { MoneyText } from '@/components/ui/MoneyText';

const { Title, Text } = Typography;

// ------------------------------------------------------------
// 枚举(本地定义,不引 @prisma/client)。
// ------------------------------------------------------------
const STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'default' },
  PENDING: { label: '待审批', color: 'processing' },
  APPROVED: { label: '已通过', color: 'success' },
  REJECTED: { label: '已驳回', color: 'error' },
  WITHDRAWN: { label: '已撤回', color: 'default' },
};

// ------------------------------------------------------------
// 类型
// ------------------------------------------------------------
interface ProjectDetail {
  id: string;
  code: string;
  name: string;
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
  subjectId: string;
  totalAdjustment: string;
  annualAdjustment: string;
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
  totalAdjustment: string;
  annualAdjustment: string;
}

let keySeq = 0;
const genKey = () => `line-${++keySeq}`;

function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

function formatDateTime(s: string | null): string {
  if (!s) return '—';
  const d = dayjs(s);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : '—';
}

/** 字符串金额 → 显示带正负号(用于明细摘要)。 */
function signedAmount(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

export default function AdjustmentsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
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
  const [formTotalReason, setFormTotalReason] = useState('');
  const [formAnnualReason, setFormAnnualReason] = useState('');
  const [formLines, setFormLines] = useState<EditLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // 只读明细 Drawer。
  const [detailTarget, setDetailTarget] = useState<AdjustmentRow | null>(null);

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
      if (e instanceof Error) message.error(e.message);
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
      if (e instanceof Error) message.error(e.message);
    } finally {
      setBaselineLoading(false);
    }
  };

  // ------------------------------------------------------------
  // 表单操作
  // ------------------------------------------------------------
  const openCreate = async () => {
    setEditingId(null);
    const y = new Date().getFullYear();
    setFormYear(y);
    setFormTotalReason('');
    setFormAnnualReason('');
    await loadBaseline(y);
    setFormLines([{ key: genKey(), subjectId: null, totalAdjustment: '', annualAdjustment: '' }]);
    setMode('form');
  };

  const openEdit = async (row: AdjustmentRow) => {
    setEditingId(row.id);
    setFormYear(row.year);
    setFormTotalReason(row.totalReason ?? '');
    setFormAnnualReason(row.annualReason ?? '');
    await loadBaseline(row.year);
    setFormLines(
      row.lines.map((l) => ({
        key: genKey(),
        subjectId: l.subjectId,
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
    setFormLines((prev) => [
      ...prev,
      { key: genKey(), subjectId: null, totalAdjustment: '', annualAdjustment: '' },
    ]);
  };

  const removeLine = (key: string) => {
    setFormLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  };

  const handleYearChange = async (y: number) => {
    setFormYear(y);
    await loadBaseline(y);
  };

  /** 构建并校验 payload。 */
  /**
   * 构建并校验 payload。
   * @param requireBalance 是否强制双维度收支平衡(草稿=false,提交=true)。
   *   草稿允许不平衡、允许调整额留空(留空按 0 处理),便于保存中间态。
   */
  const buildPayload = (
    requireBalance: boolean,
  ): { ok: boolean; payload?: unknown; error?: string } => {
    const valid = formLines.filter((l) => l.subjectId);
    if (valid.length === 0) {
      return { ok: false, error: '请至少选择一个科目' };
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
    const lines = valid.map((l) => ({
      subjectId: l.subjectId,
      // 草稿允许留空,按 0 落库;提交时已保证非空。
      totalAdjustment: l.totalAdjustment === '' ? '0' : Number(l.totalAdjustment).toFixed(2),
      annualAdjustment: l.annualAdjustment === '' ? '0' : Number(l.annualAdjustment).toFixed(2),
    }));
    return {
      ok: true,
      payload: {
        year: formYear,
        totalReason: formTotalReason.trim() || null,
        annualReason: formAnnualReason.trim() || null,
        lines,
      },
    };
  };

  const handleSaveDraft = async () => {
    // 草稿:不校验平衡,允许保存未完成的中间态。
    const { ok, payload, error } = buildPayload(false);
    if (!ok) {
      message.warning(error);
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
      message.success('已保存草稿');
      setMode('list');
      setEditingId(null);
      await reload();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAndSubmit = async () => {
    // 提交:强制双维度收支平衡。
    const { ok, payload, error } = buildPayload(true);
    if (!ok) {
      message.warning(error);
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
      message.success('已提交审批,可在审批中心查看进度');
      setMode('list');
      await reload();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitRow = async (row: AdjustmentRow) => {
    try {
      await apiFetch(`/api/projects/${projectId}/adjustments/${row.id}/submit`, {
        method: 'POST',
      });
      message.success('已提交审批');
      await reload();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    }
  };

  const deleteRow = (row: AdjustmentRow) => {
    Modal.confirm({
      title: '删除调整草稿',
      content: '确认删除该调整草稿?此操作不可撤销。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiFetch(`/api/projects/${projectId}/adjustments/${row.id}`, {
            method: 'DELETE',
          });
          message.success('已删除草稿');
          await reload();
        } catch (e) {
          if (e instanceof Error) message.error(e.message);
        }
      },
    });
  };

  /** 导出该次调整为 docx(按模板填充)。dim=total 总预算维度 / annual 年度维度。 */
  const [exporting, setExporting] = useState(false);
  const exportDocx = async (row: AdjustmentRow, dim: 'total' | 'annual') => {
    setExporting(true);
    try {
      await downloadFile(
        `/api/projects/${projectId}/adjustments/${row.id}/export?dim=${dim}`,
        dim === 'total' ? '总预算调整.docx' : '年度预算调整.docx',
      );
      message.success('已开始下载');
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
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
      if (!l.subjectId) continue;
      const amt = Number(l[field]) || 0;
      if (amt === 0) continue; // 该维度此行无调整
      const base = baselineMap.get(l.subjectId);
      const productName = base?.name ?? '';
      // 万元去尾零:l[field] 是元字符串(用户输入),直接转。
      const wan = yuanToWanTrim(l[field]);
      // "新增":该维度的原预算为 0(总维度看 totalCurrent,年度维度看 annualCurrent)。
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
    setFormTotalReason(t);
    setFormAnnualReason(a);
    message.success(t || a ? '已生成调整原因说明,可继续编辑' : '当前调整无变动,未生成说明');
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
      <>
        <Title level={3} style={{ marginTop: 0 }}>
          预算调整
        </Title>
        <Skeleton active />
      </>
    );
  }

  if (fatal || !project) {
    return (
      <>
        <Title level={3} style={{ marginTop: 0 }}>
          预算调整
        </Title>
        <Result
          status="warning"
          title="加载失败"
          subTitle={fatal}
          extra={
            <Button type="primary" onClick={() => router.push(`/projects/${projectId}`)}>
              返回项目详情
            </Button>
          }
        />
      </>
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

    const lineCols: ColumnsType<EditLine> = [
      {
        title: '科目',
        dataIndex: 'subjectId',
        width: 160,
        render: (_: unknown, r) => (
          <Select
            size="small"
            style={{ width: '100%' }}
            placeholder="选择科目"
            showSearch
            optionFilterProp="label"
            value={r.subjectId}
            onChange={(v) => updateLine(r.key, { subjectId: v })}
            options={baseline.map((s) => ({ value: s.subjectId, label: s.name }))}
          />
        ),
      },
      {
        title: '原总预算',
        key: 'origTotal',
        width: 110,
        align: 'right',
        render: (_: unknown, r) => (
          <Text type="secondary">
            {r.subjectId ? (baselineMap.get(r.subjectId)?.totalCurrent ?? '0.00') : '—'}
          </Text>
        ),
      },
      {
        title: '总预算调整额',
        key: 'totalAdj',
        width: 130,
        render: (_: unknown, r) => (
          <AmountInput
            size="small"
            allowNegative
            value={r.totalAdjustment}
            onChange={(v) => updateLine(r.key, { totalAdjustment: v ?? '' })}
          />
        ),
      },
      {
        title: '调整后总预算',
        key: 'afterTotal',
        width: 120,
        align: 'right',
        render: (_: unknown, r) => <Text strong>{r.subjectId ? afterTotal(r) : '—'}</Text>,
      },
      {
        title: '原年度预算',
        key: 'origAnnual',
        width: 110,
        align: 'right',
        render: (_: unknown, r) => (
          <Text type="secondary">
            {r.subjectId ? (baselineMap.get(r.subjectId)?.annualCurrent ?? '0.00') : '—'}
          </Text>
        ),
      },
      {
        title: '年度调整额',
        key: 'annualAdj',
        width: 130,
        render: (_: unknown, r) => (
          <AmountInput
            size="small"
            allowNegative
            value={r.annualAdjustment}
            onChange={(v) => updateLine(r.key, { annualAdjustment: v ?? '' })}
          />
        ),
      },
      {
        title: '调整后年度预算',
        key: 'afterAnnual',
        width: 130,
        align: 'right',
        render: (_: unknown, r) => <Text strong>{r.subjectId ? afterAnnual(r) : '—'}</Text>,
      },
      {
        title: '',
        key: 'op',
        width: 60,
        render: (_: unknown, r) => (
          <Button
            size="small"
            type="link"
            danger
            onClick={() => removeLine(r.key)}
            disabled={formLines.length <= 1}
          >
            删除
          </Button>
        ),
      },
    ];

    return (
      <>
        <Title level={3} style={{ marginTop: 0 }}>
          {editingId ? '编辑调整单' : '发起预算调整'} — {project.name}
        </Title>
        <Space style={{ marginBottom: 16 }}>
          <Button onClick={cancelForm}>取消</Button>
        </Space>

        <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
          <Descriptions.Item label="调整年度">
            <Select<number>
              style={{ width: 160 }}
              value={formYear}
              onChange={handleYearChange}
              loading={baselineLoading}
              options={yearOptions().map((y) => ({ label: `${y} 年`, value: y }))}
            />
          </Descriptions.Item>
          <Descriptions.Item label="调整原因">
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Space>
                <Button size="small" type="dashed" onClick={handleAutoGenerate}>
                  自动生成原因说明
                </Button>
                <Text type="secondary">根据当前调整明细自动生成,生成后可手动编辑</Text>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                总预算调整原因:
              </Text>
              <input
                style={{
                  width: 480,
                  padding: '4px 11px',
                  border: '1px solid #d9d9d9',
                  borderRadius: 6,
                }}
                placeholder="总预算调整原因说明(导出总预算调整文档用)"
                value={formTotalReason}
                onChange={(e) => setFormTotalReason(e.target.value)}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                年度预算调整原因:
              </Text>
              <input
                style={{
                  width: 480,
                  padding: '4px 11px',
                  border: '1px solid #d9d9d9',
                  borderRadius: 6,
                }}
                placeholder="年度预算调整原因说明(导出年度预算调整文档用)"
                value={formAnnualReason}
                onChange={(e) => setFormAnnualReason(e.target.value)}
              />
            </Space>
          </Descriptions.Item>
        </Descriptions>

        <div style={{ marginBottom: 8 }}>
          <Text strong>调整明细</Text>
          <Button size="small" type="dashed" style={{ marginLeft: 12 }} onClick={addLine}>
            + 新增科目行
          </Button>
        </div>
        <Table<EditLine>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={formLines}
          columns={lineCols}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: '请点击「新增科目行」' }}
          style={{ marginBottom: 16 }}
        />

        <Alert
          style={{ marginBottom: 16 }}
          type={summary.balanced ? 'success' : 'error'}
          showIcon
          message={
            <span>
              汇总:总预算调整合计{' '}
              <MoneyText value={summary.totalSum.toFixed(2)} riskOnNegative={false} /> ·
              年度调整合计 <MoneyText value={summary.annualSum.toFixed(2)} riskOnNegative={false} />
              {summary.balanced
                ? ' · 两维度均已平衡 ✓ 可提交'
                : ' · 调整合计须为 0 才可提交(原预算=调整后预算)'}
            </span>
          }
        />

        <Space>
          <Button type="primary" loading={submitting} onClick={handleSaveDraft}>
            保存草稿
          </Button>
          <Button type="primary" loading={submitting} onClick={handleSaveAndSubmit}>
            保存并提交
          </Button>
          <Button onClick={cancelForm}>取消</Button>
        </Space>
      </>
    );
  }

  // ============== 列表视图 ==============
  const listCols: ColumnsType<AdjustmentRow> = [
    {
      title: '年度',
      dataIndex: 'year',
      width: 80,
      render: (y: number) => `${y}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => {
        const meta = STATUS_META[s];
        return meta ? <Tag color={meta.color}>{meta.label}</Tag> : <Tag>{s}</Tag>;
      },
    },
    {
      title: '明细摘要',
      key: 'lines',
      render: (_: unknown, row) => {
        if (!row.lines?.length) return <Text type="secondary">—</Text>;
        return (
          <Space size={4} wrap>
            {row.lines.slice(0, 2).map((l) => (
              <span key={l.id}>
                <Text strong>{subjectName(l.subjectId)}</Text>
                <Text type="secondary"> 总{signedAmount(l.totalAdjustment)}</Text>
                <Text type="secondary"> 年{signedAmount(l.annualAdjustment)}</Text>
              </span>
            ))}
            {row.lines.length > 2 && <Text type="secondary">+{row.lines.length - 2} 行</Text>}
          </Space>
        );
      },
    },
    {
      title: '原因',
      key: 'reason',
      ellipsis: true,
      render: (_: unknown, row) => {
        const parts: string[] = [];
        if (row.totalReason) parts.push(`总:${row.totalReason}`);
        if (row.annualReason) parts.push(`年:${row.annualReason}`);
        return parts.length ? <span>{parts.join(' / ')}</span> : <Text type="secondary">—</Text>;
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (d: string) => formatDateTime(d),
    },
    {
      title: '操作',
      key: 'actions',
      width: 340,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Space size={4}>
          {row.status === 'DRAFT' && (
            <>
              <Button size="small" onClick={() => void openEdit(row)}>
                编辑
              </Button>
              <Button size="small" type="primary" onClick={() => void submitRow(row)}>
                提交审批
              </Button>
              <Button size="small" type="link" danger onClick={() => deleteRow(row)}>
                删除
              </Button>
            </>
          )}
          {row.status === 'PENDING' && <Text type="secondary">审批中</Text>}
          <Button size="small" type="link" onClick={() => setDetailTarget(row)}>
            明细
          </Button>
          <Button
            size="small"
            type="link"
            loading={exporting}
            onClick={() => void exportDocx(row, 'total')}
          >
            导出总预算
          </Button>
          <Button
            size="small"
            type="link"
            loading={exporting}
            onClick={() => void exportDocx(row, 'annual')}
          >
            导出年度
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Title level={3} style={{ marginTop: 0 }}>
        预算调整 — {project.name}
      </Title>

      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
        <Button type="primary" onClick={() => void openCreate()} disabled={!isEffective}>
          发起调整
        </Button>
      </Space>

      {!isEffective && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="初始预算尚未生效,暂无法发起预算调整"
          description="请先完成初始预算编制并审批通过,再进行预算调整。"
        />
      )}

      <Table<AdjustmentRow>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={adjustments}
        columns={listCols}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <Empty description={isEffective ? '暂无调整单,点击「发起调整」' : '暂无调整单'} />
          ),
        }}
      />

      <Drawer
        title="调整单明细"
        width={680}
        open={!!detailTarget}
        onClose={() => setDetailTarget(null)}
      >
        {detailTarget && (
          <>
            <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="年度">{detailTarget.year}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_META[detailTarget.status]?.color}>
                  {STATUS_META[detailTarget.status]?.label ?? detailTarget.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="总预算调整原因">
                {detailTarget.totalReason ?? <Text type="secondary">—</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="年度预算调整原因">
                {detailTarget.annualReason ?? <Text type="secondary">—</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {formatDateTime(detailTarget.createdAt)}
              </Descriptions.Item>
            </Descriptions>
            <Table<AdjustmentLine>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={detailTarget.lines}
              scroll={{ x: 'max-content' }}
              columns={[
                {
                  title: '科目',
                  dataIndex: 'subjectId',
                  render: (v: string) => subjectName(v),
                },
                {
                  title: '总预算调整',
                  dataIndex: 'totalAdjustment',
                  align: 'right',
                  render: (v: string) => <MoneyText value={v} riskOnNegative={false} />,
                },
                {
                  title: '年度预算调整',
                  dataIndex: 'annualAdjustment',
                  align: 'right',
                  render: (v: string) => <MoneyText value={v} riskOnNegative={false} />,
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  );
}
