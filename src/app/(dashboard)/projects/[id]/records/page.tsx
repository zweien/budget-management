'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Dropdown,
  Form,
  Input,
  InputNumber,
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

/** §8 业务记录四态(与 Prisma BusinessStatus 同步,不依赖运行时枚举以避免在 client bundle 里强引 @prisma/client)。 */
const BUSINESS_STATUSES = ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID'] as const;
type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

const STATUS_META: Record<BusinessStatus, { label: string; color: string }> = {
  PLACEHOLDER: { label: '登记占位', color: 'default' },
  CONTRACT: { label: '合同', color: 'blue' },
  FINANCE_APPROVAL: { label: '财务系统审批', color: 'processing' },
  PAID: { label: '已支出', color: 'success' },
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
  const d = dayjs(s);
  return d.isValid() ? d.format('YYYY-MM-DD') : '—';
}

/** 把时间戳统一为 YYYY-MM-DD HH:mm 展示。 */
function formatDateTime(s: string | null): string {
  if (!s) return '—';
  const d = dayjs(s);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : '—';
}

/** 新增/修改表单字段定义。 */
interface RecordFormValues {
  budgetYear: number;
  subjectId: string;
  amount: string;
  businessDate: dayjs.Dayjs;
  handler: string;
  summary: string;
  status: BusinessStatus;
  remark?: string;
}

export default function BusinessRecordsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  // 项目标题。
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
  // 新增/修改 Modal。
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BusinessRecordRow | null>(null);
  const [form] = Form.useForm<RecordFormValues>();
  // 作废 Modal。
  const [voidTarget, setVoidTarget] = useState<BusinessRecordRow | null>(null);
  const [voidForm] = Form.useForm<{ reason: string }>();
  // §17.7 历史 Drawer。
  const [historyTarget, setHistoryTarget] = useState<BusinessRecordRow | null>(null);
  const [historyRows, setHistoryRows] = useState<BusinessRecordHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // subjectId → {code, name} 映射,用于表格展示"科目(code+name)"。
  const subjectMap = useMemo(() => {
    const m = new Map<string, LeafSubject>();
    for (const s of leafSubjects) m.set(s.subjectId, s);
    return m;
  }, [leafSubjects]);

  // 拉取项目标题 + 叶科目(仅一次)。
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
          if (e instanceof Error) message.error(e.message);
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
  // 仿照 ledger 页:loading 重置放在筛选事件处理器里(effect 内只发请求 + 异步落结果),
  // 避免在 effect body 同步 setState(react-hooks/set-state-in-effect)。
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
        if (!cancelled && e instanceof Error) message.error(e.message);
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
      if (e instanceof Error) message.error(e.message);
    } finally {
      setLoadingRecords(false);
    }
  }, [projectId, yearFilter, subjectFilter, statusFilter, includeVoid]);

  /** 处理新增/修改提交后返回的 overBudget 预警(§8.4:仍已保存)。 */
  const showOverBudgetIfNeeded = (overBudget?: boolean) => {
    if (overBudget) {
      Modal.warning({
        title: '该记录导致超预算,但已保存',
        content: '本次登记使该科目在该年度的占用超过当前预算。记录已保存,请及时跟进预算调整。',
      });
    }
  };

  /** 打开"新增"Modal。 */
  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      budgetYear: new Date().getFullYear(),
      status: 'PLACEHOLDER',
      businessDate: dayjs(),
    });
    setFormOpen(true);
  };

  /** 打开"修改"Modal,预填当前行。 */
  const openEdit = (row: BusinessRecordRow) => {
    setEditing(row);
    form.setFieldsValue({
      budgetYear: row.budgetYear,
      subjectId: row.subjectId,
      amount: row.amount,
      businessDate: dayjs(row.businessDate),
      handler: row.handler,
      summary: row.summary,
      status: row.status,
      remark: row.remark ?? undefined,
    });
    setFormOpen(true);
  };

  /** 提交新增/修改。 */
  const handleSubmit = async () => {
    let values: RecordFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验失败,AntD 已在字段下提示。
    }
    const payload = {
      budgetYear: values.budgetYear,
      subjectId: values.subjectId,
      amount: values.amount,
      businessDate: values.businessDate.format('YYYY-MM-DD'),
      handler: values.handler,
      summary: values.summary,
      status: values.status,
      remark: values.remark ?? null,
    };
    setSubmitting(true);
    try {
      if (editing) {
        const res = await apiFetch<{ record: BusinessRecordRow; overBudget: boolean }>(
          `/api/projects/${projectId}/records/${editing.id}`,
          { method: 'PATCH', body: JSON.stringify(payload) },
        );
        message.success('已保存修改');
        showOverBudgetIfNeeded(res.overBudget);
      } else {
        const res = await apiFetch<{ record: BusinessRecordRow; overBudget: boolean }>(
          `/api/projects/${projectId}/records`,
          { method: 'POST', body: JSON.stringify(payload) },
        );
        message.success('已新增业务记录');
        showOverBudgetIfNeeded(res.overBudget);
      }
      setFormOpen(false);
      await reloadRecords();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 提交作废(二次确认 + 原因)。 */
  const submitVoid = async () => {
    if (!voidTarget) return;
    let reason: string;
    try {
      const v = await voidForm.validateFields();
      reason = v.reason;
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch<{ record: BusinessRecordRow }>(
        `/api/projects/${projectId}/records/${voidTarget.id}/void`,
        { method: 'POST', body: JSON.stringify({ reason }) },
      );
      message.success('已作废');
      setVoidTarget(null);
      voidForm.resetFields();
      await reloadRecords();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 筛选变化:同步重置 loading,随后由 effect 重拉数据。 */
  const applyYearFilter = (v: number | undefined) => {
    setLoadingRecords(true);
    setYearFilter(v);
  };
  const applySubjectFilter = (v: string | undefined) => {
    setLoadingRecords(true);
    setSubjectFilter(v);
  };
  const applyStatusFilter = (v: BusinessStatus | undefined) => {
    setLoadingRecords(true);
    setStatusFilter(v);
  };
  const applyIncludeVoid = (v: boolean) => {
    setLoadingRecords(true);
    setIncludeVoid(v);
  };

  /** 切换状态(下拉菜单触发)。 */
  const switchStatus = async (row: BusinessRecordRow, next: BusinessStatus) => {
    if (next === row.status) return;
    try {
      await apiFetch<{ record: BusinessRecordRow }>(
        `/api/projects/${projectId}/records/${row.id}/status`,
        { method: 'POST', body: JSON.stringify({ status: next }) },
      );
      message.success(`状态已切换为:${STATUS_META[next].label}`);
      await reloadRecords();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    }
  };

  /** §17.7 打开变更历史 Drawer,拉取该记录的 history 行。 */
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
      if (e instanceof Error) message.error(e.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const columns: ColumnsType<BusinessRecordRow> = [
    {
      title: '年度',
      dataIndex: 'budgetYear',
      key: 'budgetYear',
      width: 90,
      render: (y: number) => `${y}`,
    },
    {
      title: '科目',
      dataIndex: 'subjectId',
      key: 'subject',
      render: (subjectId: string) => {
        const s = subjectMap.get(subjectId);
        if (!s) return <Text type="secondary">{subjectId.slice(0, 8)}</Text>;
        return (
          <Space size={4}>
            <Text style={{ color: '#8c8c8c', fontFamily: 'monospace' }}>{s.code}</Text>
            <span>{s.name}</span>
          </Space>
        );
      },
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      align: 'right',
      render: (amount: string) => <MoneyText value={amount} riskOnNegative={false} />,
    },
    {
      title: '业务发生日期',
      dataIndex: 'businessDate',
      key: 'businessDate',
      width: 130,
      render: (d: string) => formatDate(d),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (_: BusinessStatus, row: BusinessRecordRow) => {
        const meta = STATUS_META[row.status] ?? { label: row.status, color: 'default' };
        return row.isVoid ? (
          <Tag color="red">已作废</Tag>
        ) : (
          <Tag color={meta.color}>{meta.label}</Tag>
        );
      },
    },
    {
      title: '经办人',
      dataIndex: 'handler',
      key: 'handler',
      width: 110,
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      key: 'summary',
      ellipsis: true,
    },
    {
      title: '录入时间',
      dataIndex: 'enteredAt',
      key: 'enteredAt',
      width: 150,
      render: (d: string) => formatDateTime(d),
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      fixed: 'right',
      render: (_: unknown, row: BusinessRecordRow) => {
        const statusMenuItems = BUSINESS_STATUSES.filter((s) => s !== row.status).map((s) => ({
          key: s,
          label: `切换为:${STATUS_META[s].label}`,
          onClick: () => void switchStatus(row, s),
        }));
        return (
          <Space size={4}>
            <Button size="small" onClick={() => openEdit(row)} disabled={row.isVoid}>
              修改
            </Button>
            <Dropdown.Button
              size="small"
              menu={{ items: statusMenuItems }}
              disabled={row.isVoid}
              trigger={['click']}
            >
              状态
            </Dropdown.Button>
            <Button size="small" danger onClick={() => setVoidTarget(row)} disabled={row.isVoid}>
              作废
            </Button>
            <Button size="small" onClick={() => void openHistory(row)}>
              历史
            </Button>
          </Space>
        );
      },
    },
  ];

  if (loadingMeta) return <Skeleton active />;

  if (fatal || !project) {
    return (
      <Result
        status="warning"
        title="无法访问该项目"
        subTitle={fatal ?? '项目可能不存在或您没有访问权限。'}
        extra={
          <Button type="primary" onClick={() => router.push('/projects')}>
            返回项目列表
          </Button>
        }
      />
    );
  }

  const subjectOptions = leafSubjects.map((s) => ({
    label: `${s.code} ${s.name}`,
    value: s.subjectId,
  }));
  const statusOptions = BUSINESS_STATUSES.map((s) => ({
    label: STATUS_META[s].label,
    value: s,
  }));

  return (
    <>
      <Title level={3} style={{ marginTop: 0 }}>
        业务记录{project ? ` — ${project.name}` : ''}
      </Title>

      <Space wrap style={{ marginBottom: 16 }}>
        <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
        <Button type="primary" onClick={openCreate}>
          新增
        </Button>
      </Space>

      <Space wrap style={{ marginBottom: 16 }}>
        <Text type="secondary">年度:</Text>
        <Select<number | undefined>
          allowClear
          placeholder="全部年度"
          value={yearFilter}
          onChange={applyYearFilter}
          style={{ width: 130 }}
          options={yearOptions().map((y) => ({ label: `${y} 年`, value: y }))}
        />
        <Text type="secondary">科目:</Text>
        <Select<string | undefined>
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="全部科目"
          value={subjectFilter}
          onChange={applySubjectFilter}
          style={{ width: 220 }}
          options={subjectOptions}
        />
        <Text type="secondary">状态:</Text>
        <Select<BusinessStatus | undefined>
          allowClear
          placeholder="全部状态"
          value={statusFilter}
          onChange={applyStatusFilter}
          style={{ width: 150 }}
          options={statusOptions}
        />
        <Checkbox checked={includeVoid} onChange={(e) => applyIncludeVoid(e.target.checked)}>
          包含作废
        </Checkbox>
      </Space>

      <Table<BusinessRecordRow>
        rowKey="id"
        columns={columns}
        dataSource={records}
        loading={loadingRecords}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
      />

      <Modal
        title={editing ? '修改业务记录' : '新增业务记录'}
        open={formOpen}
        onOk={handleSubmit}
        onCancel={() => setFormOpen(false)}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        width={560}
      >
        <Form<RecordFormValues>
          form={form}
          layout="vertical"
          initialValues={{ budgetYear: new Date().getFullYear(), status: 'PLACEHOLDER' }}
        >
          <Form.Item
            name="budgetYear"
            label="年度"
            rules={[{ required: true, message: '请输入年度' }]}
          >
            <InputNumber min={1900} max={9999} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="subjectId"
            label="科目"
            rules={[{ required: true, message: '请选择科目' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择叶科目"
              options={subjectOptions}
            />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true, message: '请输入金额' }]}>
            <AmountInput />
          </Form.Item>
          <Form.Item
            name="businessDate"
            label="业务发生日期"
            rules={[{ required: true, message: '请选择日期' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="handler"
            label="经办人"
            rules={[{ required: true, message: '请输入经办人' }]}
          >
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item
            name="summary"
            label="摘要"
            rules={[{ required: true, message: '请输入摘要' }]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="status" label="状态" rules={[{ required: true, message: '请选择状态' }]}>
            <Select options={statusOptions} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea maxLength={500} rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="作废业务记录"
        open={voidTarget !== null}
        onOk={submitVoid}
        onCancel={() => {
          setVoidTarget(null);
          voidForm.resetFields();
        }}
        confirmLoading={submitting}
        okText="确认作废"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        destroyOnHidden
      >
        {voidTarget ? (
          <Alert
            style={{ marginBottom: 12 }}
            type="warning"
            showIcon
            message={`将作废记录:${formatDate(voidTarget.businessDate)} · ${
              subjectMap.get(voidTarget.subjectId)?.name ?? ''
            } · ${voidTarget.summary}`}
            description="作废后该记录占用将由台账实时解除,不可恢复。"
          />
        ) : null}
        <Form form={voidForm} layout="vertical">
          <Form.Item
            name="reason"
            label="作废原因"
            rules={[{ required: true, message: '请填写作废原因' }]}
          >
            <Input.TextArea maxLength={200} rows={3} placeholder="请填写作废原因" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="变更历史"
        open={historyTarget !== null}
        onClose={() => setHistoryTarget(null)}
        width={640}
        destroyOnHidden
      >
        {historyTarget ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="业务发生日期">
                {formatDate(historyTarget.businessDate)}
              </Descriptions.Item>
              <Descriptions.Item label="摘要">{historyTarget.summary}</Descriptions.Item>
              <Descriptions.Item label="金额">
                <MoneyText value={historyTarget.amount} riskOnNegative={false} />
              </Descriptions.Item>
            </Descriptions>

            <Text type="secondary">§17.7 变更链(按时间正序),共 {historyRows.length} 条。</Text>

            <Table<BusinessRecordHistoryRow>
              rowKey="id"
              size="small"
              loading={historyLoading}
              dataSource={historyRows}
              pagination={false}
              scroll={{ x: 'max-content' }}
              locale={{ emptyText: historyLoading ? '加载中…' : '暂无变更历史' }}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'operatedAt',
                  key: 'operatedAt',
                  width: 150,
                  render: (d: string) => formatDateTime(d),
                },
                {
                  title: '操作',
                  dataIndex: 'action',
                  key: 'action',
                  width: 110,
                  render: (a: string) => HISTORY_ACTION_LABEL[a] ?? a,
                },
                {
                  title: '操作人',
                  dataIndex: 'operatorId',
                  key: 'operatorId',
                  width: 120,
                  ellipsis: true,
                  render: (id: string) => id.slice(0, 8),
                },
                {
                  title: '原因',
                  dataIndex: 'reason',
                  key: 'reason',
                  ellipsis: true,
                  render: (r: string | null) => r ?? <Text type="secondary">—</Text>,
                },
                {
                  title: '变更前',
                  key: 'before',
                  render: (_: unknown, row: BusinessRecordHistoryRow) =>
                    row.beforeData ? (
                      <Text
                        style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}
                      >
                        {JSON.stringify(row.beforeData, null, 2)}
                      </Text>
                    ) : (
                      <Text type="secondary">—</Text>
                    ),
                },
                {
                  title: '变更后',
                  key: 'after',
                  render: (_: unknown, row: BusinessRecordHistoryRow) =>
                    row.afterData ? (
                      <Text
                        style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}
                      >
                        {JSON.stringify(row.afterData, null, 2)}
                      </Text>
                    ) : (
                      <Text type="secondary">—</Text>
                    ),
                },
              ]}
            />
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}
