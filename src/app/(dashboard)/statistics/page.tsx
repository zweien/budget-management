'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Row,
  Select,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';

import { apiFetch } from '@/lib/api/client';
import { MoneyText } from '@/components/ui/MoneyText';

const { Title, Text } = Typography;

// ---- §8 业务记录四态(与 Prisma BusinessStatus 同步,不依赖运行时枚举,
//      避免 client bundle 强引 @prisma/client)。 ----
const BUSINESS_STATUSES = ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID'] as const;
type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

const STATUS_META: Record<BusinessStatus, { label: string; color: string }> = {
  PLACEHOLDER: { label: '登记占位', color: 'default' },
  CONTRACT: { label: '合同', color: 'blue' },
  FINANCE_APPROVAL: { label: '财务系统审批', color: 'processing' },
  PAID: { label: '已支出', color: 'success' },
};

// ---- 通用类型 ----

interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

interface CurrentUser {
  id: string;
  name: string;
  role: string;
}

/** 叶科目(从 ledger nodes isLeaf=true 取得)。 */
interface LeafSubject {
  subjectId: string;
  code: string;
  name: string;
}

interface LedgerResponse {
  year: number;
  nodes: Array<{ subjectId: string; code: string; name: string; isLeaf: boolean }>;
}

/** 生成最近 5 年的年度选项(含当前年,按降序)。 */
function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

/** 把 businessDate(可能是 ISO 或带 T 的字符串)统一为 YYYY-MM-DD 展示。 */
function formatDate(s: string | null | undefined): string {
  if (!s) return '—';
  const d = dayjs(s);
  return d.isValid() ? d.format('YYYY-MM-DD') : '—';
}

/** 把执行率(number|null)渲染为百分比。 */
function renderRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(2)}%`;
}

// ============================================================
// 主组件
// ============================================================
export default function StatisticsPage() {
  // 拉取当前用户(用于跨项目 tab 鉴权判定)。
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<CurrentUser>('/api/me')
      .then((u) => {
        if (!cancelled) setCurrentUser(u);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) message.error(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingUser(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadingUser) return <Skeleton active />;

  const isAdmin = currentUser?.role === 'BUDGET_ADMIN';

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>
        统计分析
      </Title>
      <Text type="secondary">自定义统计、月度历史、跨项目汇总(§11.3-11.5)。</Text>

      <Tabs
        defaultActiveKey="custom"
        items={[
          {
            key: 'custom',
            label: '自定义统计',
            children: <CustomStatisticsTab />,
          },
          {
            key: 'monthly',
            label: '月度历史',
            children: <MonthlyHistoryTab />,
          },
          {
            key: 'cross',
            label: '跨项目统计',
            children: <CrossProjectTab isAdmin={isAdmin} />,
          },
        ]}
      />
    </Space>
  );
}

// ============================================================
// 加载可访问项目(三个 tab 共用)
// ============================================================
function useAccessibleProjects(): {
  projects: ProjectOption[];
  loading: boolean;
} {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectOption[]>('/api/projects')
      .then((rows) => {
        if (!cancelled) setProjects(rows ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) message.error(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { projects, loading };
}

/** 拉取项目叶科目(用于科目筛选下拉)。 */
function useLeafSubjects(projectId: string | undefined): {
  subjects: LeafSubject[];
  loading: boolean;
} {
  const [subjects, setSubjects] = useState<LeafSubject[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 无项目时不发请求;科目 Select 由调用方按 projectId 禁用,选择新项目时
    // 本 effect 会重拉并替换(故无需在此同步清空,避免 effect 内同步 setState)。
    if (!projectId) return;
    let cancelled = false;
    apiFetch<LedgerResponse>(`/api/projects/${projectId}/ledger`)
      .then((ledger) => {
        if (cancelled) return;
        const leaves: LeafSubject[] = (ledger.nodes ?? [])
          .filter((n) => n.isLeaf)
          .map((n) => ({ subjectId: n.subjectId, code: n.code, name: n.name }))
          .sort((a, b) => a.code.localeCompare(b.code));
        setSubjects(leaves);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) message.error(e.message);
        if (!cancelled) setSubjects([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { subjects, loading };
}

// ============================================================
// Tab 1: 自定义统计(§11.3)
// ============================================================

interface CustomSummary {
  currentBudget: string;
  paid: string;
  payable: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
}

interface CustomRecord {
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
  isVoid: boolean;
  remark: string | null;
  subject: { id: string; code: string; name: string };
}

interface CustomResult {
  summary: CustomSummary;
  records: CustomRecord[];
}

interface CustomFilters {
  projectId?: string;
  budgetYear?: number;
  subjectId?: string;
  status?: BusinessStatus;
  dateRange?: [Dayjs, Dayjs];
  handler?: string;
  includeVoid?: boolean;
}

function CustomStatisticsTab() {
  const { projects, loading: loadingProjects } = useAccessibleProjects();
  const [form] = Form.useForm<CustomFilters>();
  // 活跃筛选(查询后落定,避免每次输入都查询)。
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const { subjects } = useLeafSubjects(activeProjectId);

  const [result, setResult] = useState<CustomResult | null>(null);
  // 初始即 true:挂载自动查询,避免 mount effect 内同步 setState(react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [hasQueried, setHasQueried] = useState(false);

  const subjectMap = useMemo(() => {
    const m = new Map<string, LeafSubject>();
    for (const s of subjects) m.set(s.subjectId, s);
    return m;
  }, [subjects]);

  // setLoading(true) 由调用方(事件处理器 / 初始 state)负责,函数内只做异步落值。
  const runQuery = useCallback(async () => {
    let values: CustomFilters;
    try {
      values = await form.validateFields();
    } catch {
      return; // AntD 已在字段下提示。
    }
    try {
      const qs = new URLSearchParams();
      if (values.projectId) qs.set('projectId', values.projectId);
      if (values.budgetYear !== undefined) qs.set('budgetYear', String(values.budgetYear));
      if (values.subjectId) qs.set('subjectId', values.subjectId);
      if (values.status) qs.set('status', values.status);
      if (values.dateRange?.[0])
        qs.set('businessDateFrom', values.dateRange[0].format('YYYY-MM-DD'));
      if (values.dateRange?.[1]) qs.set('businessDateTo', values.dateRange[1].format('YYYY-MM-DD'));
      if (values.handler?.trim()) qs.set('handler', values.handler.trim());
      if (values.includeVoid) qs.set('includeVoid', '1');
      const suffix = qs.toString();
      const data = await apiFetch<CustomResult>(
        `/api/statistics/custom${suffix ? `?${suffix}` : ''}`,
      );
      setResult(data);
      setActiveProjectId(values.projectId);
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setLoading(false);
      setHasQueried(true);
    }
  }, [form]);

  // 首次挂载查询一次(loading 已为 true)。仿 records 页:effect 内直接发起异步请求,
  // 在 .then/.finally 异步回调里落值,避免在 effect body 内同步调用含 setState 的函数。
  useEffect(() => {
    let cancelled = false;
    apiFetch<CustomResult>('/api/statistics/custom')
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) message.error(e.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setHasQueried(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleQueryClick = () => {
    setLoading(true);
    void runQuery();
  };

  const columns: ColumnsType<CustomRecord> = [
    {
      title: '科目编码',
      key: 'subjectCode',
      width: 130,
      render: (_: unknown, r: CustomRecord) =>
        r.subject?.code ?? subjectMap.get(r.subjectId)?.code ?? r.subjectId.slice(0, 8),
    },
    {
      title: '科目名称',
      key: 'subjectName',
      ellipsis: true,
      render: (_: unknown, r: CustomRecord) =>
        r.subject?.name ?? subjectMap.get(r.subjectId)?.name ?? '—',
    },
    {
      title: '年度',
      dataIndex: 'budgetYear',
      key: 'budgetYear',
      width: 90,
    },
    {
      title: '业务发生日期',
      dataIndex: 'businessDate',
      key: 'businessDate',
      width: 130,
      render: (d: string) => formatDate(d),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      align: 'right',
      render: (amount: string) => <MoneyText value={amount} riskOnNegative={false} />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (_: BusinessStatus, r: CustomRecord) => {
        const meta = STATUS_META[r.status] ?? { label: r.status, color: 'default' };
        return r.isVoid ? (
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
      render: (s: string) => s || <Text type="secondary">—</Text>,
    },
  ];

  const summary = result?.summary;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Form<CustomFilters> form={form} layout="inline" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <Form.Item name="projectId" label="项目">
          <Select<string>
            style={{ width: 220 }}
            allowClear
            loading={loadingProjects}
            placeholder="跨项目(管理员)"
            options={projects.map((p) => ({
              value: p.id,
              label: `${p.code} ${p.name}`,
            }))}
          />
        </Form.Item>
        <Form.Item name="budgetYear" label="年度">
          <Select<number>
            style={{ width: 120 }}
            allowClear
            options={yearOptions().map((y) => ({ value: y, label: String(y) }))}
          />
        </Form.Item>
        <Form.Item shouldUpdate noStyle>
          {() => {
            const pid = form.getFieldValue('projectId') as string | undefined;
            return (
              <Form.Item name="subjectId" label="科目">
                <Select<string>
                  style={{ width: 220 }}
                  allowClear
                  disabled={!pid}
                  placeholder={pid ? '选择科目' : '请先选项目'}
                  options={subjects.map((s) => ({
                    value: s.subjectId,
                    label: `${s.code} ${s.name}`,
                  }))}
                />
              </Form.Item>
            );
          }}
        </Form.Item>
        <Form.Item name="status" label="状态">
          <Select<BusinessStatus>
            style={{ width: 160 }}
            allowClear
            options={BUSINESS_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))}
          />
        </Form.Item>
        <Form.Item name="dateRange" label="业务发生日期">
          <DatePicker.RangePicker style={{ width: 240 }} />
        </Form.Item>
        <Form.Item name="handler" label="经办人">
          <Input allowClear placeholder="模糊匹配" style={{ width: 140 }} />
        </Form.Item>
        <Form.Item name="includeVoid" label="是否作废" valuePropName="checked">
          <Switch checkedChildren="含作废" unCheckedChildren="仅有效" />
        </Form.Item>
        <Form.Item>
          <Button type="primary" loading={loading} onClick={handleQueryClick}>
            查询
          </Button>
        </Form.Item>
      </Form>

      {summary && (
        <Row gutter={[16, 16]}>
          <Col xs={12} md={8} lg={4}>
            <Card size="small">
              <Statistic
                title="当前预算"
                formatter={() => <MoneyText value={summary.currentBudget} riskOnNegative={false} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small">
              <Statistic
                title="已支出"
                formatter={() => <MoneyText value={summary.paid} riskOnNegative={false} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small">
              <Statistic
                title="应付未付"
                formatter={() => <MoneyText value={summary.payable} riskOnNegative={false} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small">
              <Statistic
                title="总占用"
                formatter={() => <MoneyText value={summary.totalOccupied} riskOnNegative={false} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small">
              <Statistic title="结余" formatter={() => <MoneyText value={summary.balance} />} />
            </Card>
          </Col>
          <Col xs={12} md={8} lg={4}>
            <Card size="small">
              <Statistic title="执行率" value={renderRate(summary.executionRate)} />
            </Card>
          </Col>
        </Row>
      )}

      <Table<CustomRecord>
        rowKey="id"
        loading={loading}
        dataSource={result?.records ?? []}
        columns={columns}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: hasQueried ? '没有匹配的业务记录' : '点击"查询"加载明细',
        }}
      />
    </Space>
  );
}

// ============================================================
// Tab 2: 月度历史(§11.4)
// ============================================================

interface MonthlyBucket {
  month: number;
  paid: string;
  payable: string;
  totalOccupied: string;
}

interface MonthlyResult {
  months: MonthlyBucket[];
}

interface MonthlyFilters {
  projectId?: string;
  year?: number;
}

function MonthlyHistoryTab() {
  const { projects, loading: loadingProjects } = useAccessibleProjects();
  const [form] = Form.useForm<MonthlyFilters>();
  const [result, setResult] = useState<MonthlyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);

  const runQuery = useCallback(async () => {
    let values: MonthlyFilters;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (!values.projectId || values.year === undefined) {
      message.warning('请选择项目与年度');
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        projectId: values.projectId,
        year: String(values.year),
      });
      const data = await apiFetch<MonthlyResult>(`/api/statistics/monthly?${qs.toString()}`);
      setResult(data);
      setActiveProjectId(values.projectId);
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [form]);

  const columns: ColumnsType<MonthlyBucket> = [
    {
      title: '月份',
      dataIndex: 'month',
      key: 'month',
      width: 100,
      render: (m: number) => `${m} 月`,
    },
    {
      title: '已支出',
      dataIndex: 'paid',
      key: 'paid',
      align: 'right',
      render: (v: string) => <MoneyText value={v} riskOnNegative={false} />,
    },
    {
      title: '应付未付',
      dataIndex: 'payable',
      key: 'payable',
      align: 'right',
      render: (v: string) => <MoneyText value={v} riskOnNegative={false} />,
    },
    {
      title: '总占用',
      dataIndex: 'totalOccupied',
      key: 'totalOccupied',
      align: 'right',
      render: (v: string) => <MoneyText value={v} riskOnNegative={false} />,
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Form<MonthlyFilters> form={form} layout="inline" style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <Form.Item
          name="projectId"
          label="项目"
          rules={[{ required: true, message: '请选择项目' }]}
        >
          <Select<string>
            style={{ width: 240 }}
            loading={loadingProjects}
            placeholder="选择项目"
            options={projects.map((p) => ({
              value: p.id,
              label: `${p.code} ${p.name}`,
            }))}
          />
        </Form.Item>
        <Form.Item name="year" label="年度" rules={[{ required: true, message: '请选择年度' }]}>
          <Select<number>
            style={{ width: 120 }}
            placeholder="选择年度"
            options={yearOptions().map((y) => ({ value: y, label: String(y) }))}
          />
        </Form.Item>
        <Form.Item>
          <Button type="primary" loading={loading} onClick={() => void runQuery()}>
            查询
          </Button>
        </Form.Item>
      </Form>

      <Alert
        type="info"
        showIcon
        message="按业务发生日期归月,实时重算;仅统计有效(非作废)记录(§11.4)。"
      />

      <Table<MonthlyBucket>
        rowKey="month"
        loading={loading}
        dataSource={result?.months ?? []}
        columns={columns}
        pagination={false}
        locale={{ emptyText: activeProjectId ? '暂无数据' : '选择项目与年度后查询' }}
      />
    </Space>
  );
}

// ============================================================
// Tab 3: 跨项目统计(§11.5) — admin only
// ============================================================

interface CrossProjectRow {
  projectId: string;
  name: string;
  currentBudget: string;
  totalOccupied: string;
  paid: string;
  balance: string;
  executionRate: number | null;
}

interface CrossProjectResult {
  projects: CrossProjectRow[];
}

function CrossProjectTab({ isAdmin }: { isAdmin: boolean }) {
  const [result, setResult] = useState<CrossProjectResult | null>(null);
  // 初始即 true(admin 挂载自动查询),避免 mount effect 内同步 setState。
  const [loading, setLoading] = useState(true);
  const [hasQueried, setHasQueried] = useState(false);

  // setLoading(true) 由调用方(初始 state / 事件处理器)负责,函数内只做异步落值。
  const runQuery = useCallback(async () => {
    try {
      const data = await apiFetch<CrossProjectResult>('/api/statistics/cross-project');
      setResult(data);
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setLoading(false);
      setHasQueried(true);
    }
  }, []);

  // 仅管理员首次挂载自动查询一次(loading 已为 true)。effect 内直接发起异步请求,
  // 在 .then/.finally 异步回调里落值,避免 effect body 内同步 setState。
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    apiFetch<CrossProjectResult>('/api/statistics/cross-project')
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) message.error(e.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setHasQueried(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const handleRefresh = () => {
    setLoading(true);
    void runQuery();
  };

  const columns: ColumnsType<CrossProjectRow> = [
    {
      title: '项目',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '当前预算',
      dataIndex: 'currentBudget',
      key: 'currentBudget',
      align: 'right',
      render: (v: string) => <MoneyText value={v} riskOnNegative={false} />,
    },
    {
      title: '已支出',
      dataIndex: 'paid',
      key: 'paid',
      align: 'right',
      render: (v: string) => <MoneyText value={v} riskOnNegative={false} />,
    },
    {
      title: '总占用',
      dataIndex: 'totalOccupied',
      key: 'totalOccupied',
      align: 'right',
      render: (v: string) => <MoneyText value={v} riskOnNegative={false} />,
    },
    {
      title: '结余',
      dataIndex: 'balance',
      key: 'balance',
      align: 'right',
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: '执行率',
      dataIndex: 'executionRate',
      key: 'executionRate',
      align: 'right',
      width: 120,
      render: (rate: number | null) => renderRate(rate),
    },
  ];

  if (!isAdmin) {
    return (
      <Alert
        type="warning"
        showIcon
        message="仅预算管理员可访问"
        description="跨项目统计(§11.5)仅 BUDGET_ADMIN 可执行。"
      />
    );
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space>
        <Button type="primary" loading={loading} onClick={handleRefresh}>
          刷新
        </Button>
      </Space>

      <Alert
        type="info"
        showIcon
        message="跨项目汇总管理员可见的全部项目(非归档),同名科目不合并(§11.5)。"
      />

      <Table<CrossProjectRow>
        rowKey="projectId"
        loading={loading}
        dataSource={result?.projects ?? []}
        columns={columns}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        locale={{ emptyText: hasQueried ? '暂无项目' : '点击"刷新"加载' }}
      />
    </Space>
  );
}
