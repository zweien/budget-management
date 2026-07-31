'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
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

import { apiFetch } from '@/lib/api/client';
import { AmountInput } from '@/components/ui/AmountInput';
import { MoneyText } from '@/components/ui/MoneyText';

const { Title, Text } = Typography;

// ------------------------------------------------------------
// 枚举(本地定义,不引 @prisma/client,遵循现有约定)。
// ------------------------------------------------------------
const ADJUSTMENT_TYPES = ['SUBJECT', 'SUBJECT_TRANSFER'] as const;
type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

const TYPE_LABEL: Record<AdjustmentType, string> = {
  SUBJECT: '科目调整',
  SUBJECT_TRANSFER: '科目调剂',
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: 'default' },
  PENDING: { label: '待审批', color: 'processing' },
  APPROVED: { label: '已通过', color: 'success' },
  REJECTED: { label: '已驳回', color: 'error' },
  WITHDRAWN: { label: '已撤回', color: 'default' },
};

const DIRECTION_LABEL: Record<string, string> = {
  INCREASE: '增加',
  DECREASE: '减少',
};

const DIRECTION_COLOR: Record<string, string> = {
  INCREASE: 'green',
  DECREASE: 'red',
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

interface LedgerNode {
  subjectId: string;
  code: string;
  name: string;
  isLeaf: boolean;
}

interface LeafSubject {
  subjectId: string;
  code: string;
  name: string;
}

/** 调整明细行(对应后端 BudgetAdjustmentLine)。 */
interface AdjustmentLine {
  id: string;
  levelType: string;
  year: number | null;
  subjectId: string | null;
  direction: 'INCREASE' | 'DECREASE';
  amount: string;
}

/** 调整单(对应后端 BudgetAdjustment,含 lines)。 */
interface AdjustmentRow {
  id: string;
  type: string;
  status: string;
  reason: string | null;
  applicantId: string;
  createdAt: string;
  lines: AdjustmentLine[];
}

/** 列表响应。 */
interface ListResponse {
  adjustments: AdjustmentRow[];
}

/** 表单内的明细编辑行(用本地 key 维护)。 */
interface EditLine {
  key: string;
  subjectId: string | null;
  year: number | null;
  direction: 'INCREASE' | 'DECREASE';
  amount: string;
}

let keySeq = 0;
const genKey = () => `line-${++keySeq}`;

/** 生成最近 5 年的年度选项(含当前年,按降序)。 */
function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

function formatDateTime(s: string | null): string {
  if (!s) return '—';
  const d = dayjs(s);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : '—';
}

export default function AdjustmentsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [budgetStatus, setBudgetStatus] = useState<string | null>(null);
  const [leafSubjects, setLeafSubjects] = useState<LeafSubject[]>([]);
  const [adjustments, setAdjustments] = useState<AdjustmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  // 列表 / 表单 视图切换。
  const [mode, setMode] = useState<'list' | 'form'>('list');
  // 表单状态。
  const [formType, setFormType] = useState<AdjustmentType>('SUBJECT');
  const [formReason, setFormReason] = useState('');
  const [formLines, setFormLines] = useState<EditLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // 编辑现有草稿时记录其 id(保存走 PATCH 概念,但后端无 update,这里用"删旧建新"——见下)。
  const [editingId, setEditingId] = useState<string | null>(null);

  // 只读明细 Drawer。
  const [detailTarget, setDetailTarget] = useState<AdjustmentRow | null>(null);

  /** 初始预算是否已生效(发起调整的前提)。 */
  const isEffective = budgetStatus === 'APPROVED';

  const subjectName = (subjectId: string | null): string => {
    if (!subjectId) return '—';
    return leafSubjects.find((s) => s.subjectId === subjectId)?.name ?? subjectId.slice(0, 8);
  };

  // 拉取项目头 + 初始预算状态 + 叶科目(仅一次)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [proj, budget, ledger] = await Promise.all([
          apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
          apiFetch<InitialBudgetState | null>(`/api/projects/${projectId}/initial-budget`).catch(
            () => null,
          ),
          apiFetch<{ nodes: LedgerNode[] }>(`/api/projects/${projectId}/ledger`).catch(() => ({
            nodes: [],
          })),
        ]);
        if (cancelled) return;
        setProject(proj);
        setBudgetStatus(budget?.status ?? null);
        // ledger 已按 sortOrder 排序,保持原序,不再 localeCompare。
        const leaves: LeafSubject[] = (ledger.nodes ?? [])
          .filter((n) => n.isLeaf)
          .map((n) => ({ subjectId: n.subjectId, code: n.code, name: n.name }));
        setLeafSubjects(leaves);
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
      const { adjustments: list } = await apiFetch<ListResponse>(
        `/api/projects/${projectId}/adjustments`,
      );
      setAdjustments(list);
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

  // ------------------------------------------------------------
  // 表单操作
  // ------------------------------------------------------------
  const openCreate = () => {
    setEditingId(null);
    setFormType('SUBJECT');
    setFormReason('');
    setFormLines([
      {
        key: genKey(),
        subjectId: null,
        year: new Date().getFullYear(),
        direction: 'INCREASE',
        amount: '',
      },
    ]);
    setMode('form');
  };

  const openEdit = (row: AdjustmentRow) => {
    setEditingId(row.id);
    setFormType(row.type as AdjustmentType);
    setFormReason(row.reason ?? '');
    setFormLines(
      row.lines.map((l) => ({
        key: genKey(),
        subjectId: l.subjectId,
        year: l.year,
        direction: l.direction,
        amount: l.amount,
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
      {
        key: genKey(),
        subjectId: null,
        year: new Date().getFullYear(),
        direction: 'DECREASE',
        amount: '',
      },
    ]);
  };

  const removeLine = (key: string) => {
    setFormLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  };

  /** 构建 payload,校验后返回 { ok, payload?, error? }。 */
  const buildPayload = (): { ok: boolean; payload?: unknown; error?: string } => {
    const valid = formLines.filter(
      (l) => l.subjectId && l.year != null && l.amount && Number(l.amount) > 0,
    );
    if (valid.length === 0) {
      return { ok: false, error: '请至少填写一行完整明细(科目、年度、金额)' };
    }
    for (const l of valid) {
      if (!l.subjectId) return { ok: false, error: '每行需选择科目' };
      if (l.year == null) return { ok: false, error: '每行需选择年度' };
    }
    const lines = valid.map((l) => ({
      levelType: 'SUBJECT' as const,
      year: l.year,
      subjectId: l.subjectId,
      direction: l.direction,
      amount: l.amount,
    }));

    // 科目调剂:增加合计必须等于减少合计。
    if (formType === 'SUBJECT_TRANSFER') {
      const inc = valid
        .filter((l) => l.direction === 'INCREASE')
        .reduce((a, l) => a + Number(l.amount), 0);
      const dec = valid
        .filter((l) => l.direction === 'DECREASE')
        .reduce((a, l) => a + Number(l.amount), 0);
      if (inc === 0 || dec === 0) {
        return { ok: false, error: '科目调剂需同时包含增加和减少明细' };
      }
      if (Math.abs(inc - dec) > 0.001) {
        return {
          ok: false,
          error: `科目调剂需收支平衡:增加合计 ${inc.toFixed(2)} ≠ 减少合计 ${dec.toFixed(2)}`,
        };
      }
    }
    return { ok: true, payload: { type: formType, reason: formReason.trim() || null, lines } };
  };

  /** 保存草稿(新建 POST / 编辑 PATCH)。 */
  const handleSaveDraft = async () => {
    const { ok, payload, error } = buildPayload();
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

  /** 保存并提交:POST 创建 → POST submit。 */
  const handleSaveAndSubmit = async () => {
    const { ok, payload, error } = buildPayload();
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

  /** 列表行操作:提交审批。 */
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

  /** 列表行操作:删除草稿(二次确认)。 */
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

  // ------------------------------------------------------------
  // 实时校验提示(调剂平衡)。
  // ------------------------------------------------------------
  const balanceInfo = useMemo(() => {
    if (formType !== 'SUBJECT_TRANSFER') return null;
    const inc = formLines
      .filter((l) => l.direction === 'INCREASE')
      .reduce((a, l) => a + Number(l.amount || 0), 0);
    const dec = formLines
      .filter((l) => l.direction === 'DECREASE')
      .reduce((a, l) => a + Number(l.amount || 0), 0);
    const balanced = inc > 0 && dec > 0 && Math.abs(inc - dec) < 0.001;
    return { inc, dec, balanced };
  }, [formType, formLines]);

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
    const lineCols: ColumnsType<EditLine> = [
      {
        title: '科目',
        dataIndex: 'subjectId',
        width: 220,
        render: (_: unknown, r) => (
          <Select
            size="small"
            style={{ width: '100%' }}
            placeholder="选择叶科目"
            showSearch
            optionFilterProp="label"
            value={r.subjectId}
            onChange={(v) => updateLine(r.key, { subjectId: v })}
            options={leafSubjects.map((s) => ({ value: s.subjectId, label: s.name }))}
          />
        ),
      },
      {
        title: '年度',
        dataIndex: 'year',
        width: 110,
        render: (_: unknown, r) => (
          <Select<number>
            size="small"
            style={{ width: '100%' }}
            value={r.year ?? undefined}
            onChange={(v) => updateLine(r.key, { year: v })}
            options={yearOptions().map((y) => ({ label: `${y}`, value: y }))}
          />
        ),
      },
      {
        title: '方向',
        dataIndex: 'direction',
        width: 110,
        render: (_: unknown, r) => (
          <Select
            size="small"
            style={{ width: '100%' }}
            value={r.direction}
            onChange={(v) => updateLine(r.key, { direction: v })}
            options={[
              { value: 'INCREASE', label: '增加' },
              { value: 'DECREASE', label: '减少' },
            ]}
          />
        ),
      },
      {
        title: '金额',
        dataIndex: 'amount',
        width: 160,
        render: (_: unknown, r) => (
          <AmountInput
            size="small"
            allowNegative
            value={r.amount}
            onChange={(v) => updateLine(r.key, { amount: v ?? '' })}
          />
        ),
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

        <Card size="small" style={{ marginBottom: 16 }}>
          <Descriptions column={1} size="small">
            <Descriptions.Item label="调整类型">
              <Select<AdjustmentType>
                style={{ width: 200 }}
                value={formType}
                onChange={setFormType}
                options={ADJUSTMENT_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
              />
              <Text type="secondary" style={{ marginLeft: 12 }}>
                {formType === 'SUBJECT'
                  ? '对单个科目年度预算进行增减'
                  : '同一年度内在科目间转移预算(收支须平衡)'}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="调整原因">
              <input
                style={{
                  width: 480,
                  padding: '4px 11px',
                  border: '1px solid #d9d9d9',
                  borderRadius: 6,
                }}
                placeholder="简要说明调整原因(选填)"
                value={formReason}
                onChange={(e) => setFormReason(e.target.value)}
              />
            </Descriptions.Item>
          </Descriptions>
        </Card>

        <div style={{ marginBottom: 8 }}>
          <Text strong>调整明细</Text>
          <Button size="small" type="dashed" style={{ marginLeft: 12 }} onClick={addLine}>
            + 新增明细
          </Button>
        </div>
        <Table<EditLine>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={formLines}
          columns={lineCols}
          locale={{ emptyText: '请点击「新增明细」' }}
          style={{ marginBottom: 16 }}
        />

        {balanceInfo && (
          <Alert
            style={{ marginBottom: 16 }}
            type={balanceInfo.balanced ? 'success' : 'warning'}
            showIcon
            message={
              <span>
                增加合计 <MoneyText value={balanceInfo.inc.toFixed(2)} riskOnNegative={false} /> ·
                减少合计 <MoneyText value={balanceInfo.dec.toFixed(2)} riskOnNegative={false} />
                {balanceInfo.balanced ? ' · 收支平衡 ✓' : ' · 收支不平衡,需调整至相等'}
              </span>
            }
          />
        )}

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
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (t: string) => <Tag>{TYPE_LABEL[t as AdjustmentType] ?? t}</Tag>,
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
              <Tag key={l.id} color={DIRECTION_COLOR[l.direction]}>
                {subjectName(l.subjectId)}
                {l.year ? ` ${l.year}` : ''}
                {DIRECTION_LABEL[l.direction]} {Number(l.amount).toFixed(2)}
              </Tag>
            ))}
            {row.lines.length > 2 && <Text type="secondary">+{row.lines.length - 2} 行</Text>}
          </Space>
        );
      },
    },
    {
      title: '原因',
      dataIndex: 'reason',
      ellipsis: true,
      render: (r: string | null) => r ?? <Text type="secondary">—</Text>,
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
      width: 200,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Space size={4}>
          {row.status === 'DRAFT' && (
            <>
              <Button size="small" onClick={() => openEdit(row)}>
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
        <Button type="primary" onClick={openCreate} disabled={!isEffective}>
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

      {/* 只读明细 Drawer */}
      <Drawer
        title="调整单明细"
        width={640}
        open={!!detailTarget}
        onClose={() => setDetailTarget(null)}
      >
        {detailTarget && (
          <>
            <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="类型">
                {TYPE_LABEL[detailTarget.type as AdjustmentType] ?? detailTarget.type}
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_META[detailTarget.status]?.color}>
                  {STATUS_META[detailTarget.status]?.label ?? detailTarget.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="原因">
                {detailTarget.reason ?? <Text type="secondary">—</Text>}
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
              columns={[
                {
                  title: '科目',
                  dataIndex: 'subjectId',
                  render: (v: string | null) => subjectName(v),
                },
                { title: '年度', dataIndex: 'year', render: (v: number | null) => v ?? '—' },
                {
                  title: '方向',
                  dataIndex: 'direction',
                  render: (d: string) => <Tag color={DIRECTION_COLOR[d]}>{DIRECTION_LABEL[d]}</Tag>,
                },
                {
                  title: '金额',
                  dataIndex: 'amount',
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
