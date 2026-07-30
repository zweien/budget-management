'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';

import { apiFetch } from '@/lib/api/client';

const { Title, Text, Paragraph } = Typography;

interface OperatorRef {
  id: string;
  name: string;
}

interface AuditLogRow {
  id: string;
  projectId: string | null;
  objectType: string;
  objectId: string;
  action: string;
  beforeData: unknown;
  afterData: unknown;
  operatorId: string;
  operatedAt: string;
  operator: OperatorRef;
}

interface AuditLogResponse {
  logs: AuditLogRow[];
  total: number;
}

interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

interface UserOption {
  id: string;
  name: string;
  role: string;
}

interface FilterValues {
  projectId?: string;
  objectType?: string;
  action?: string;
  operatorId?: string;
  dateRange?: [Dayjs, Dayjs];
}

/** §14.1 已知对象类型(与 server recordAudit 调用点保持一致)。 */
const OBJECT_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'project', label: '项目' },
  { value: 'initial_budget_applications', label: '初始预算编制' },
  { value: 'budget_adjustments', label: '预算调整' },
  { value: 'subject_change_applications', label: '科目变更' },
  { value: 'business_records', label: '业务记录' },
  { value: 'receipt_records', label: '到账流水' },
];

/** §14.1 已知动作类型(与 server recordAudit 调用点保持一致)。 */
const ACTION_OPTIONS: { value: string; label: string }[] = [
  { value: 'create', label: '新建' },
  { value: 'update', label: '修改' },
  { value: 'delete', label: '删除' },
  { value: 'submit', label: '提交' },
  { value: 'approve', label: '审批通过' },
  { value: 'reject', label: '驳回' },
  { value: 'withdraw', label: '撤回' },
  { value: 'archive', label: '归档' },
  { value: 'void', label: '作废' },
  { value: 'status_switch', label: '状态切换' },
  { value: 'import', label: '导入' },
  { value: 'carryover', label: '跨年结转' },
];

const formatDateTime = (s: string | null): string => {
  if (!s) return '—';
  const d = dayjs(s);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm:ss') : '—';
};

/** 把任意 JSON 值渲染为缩进 JSON 文本(null/空 → 占位)。 */
function renderJson(v: unknown): string {
  if (v === null || v === undefined) return '—';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  // 初始即 true:挂载自动查询,避免 mount effect 内同步 setState。
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);

  // 活跃筛选(查询后落定)。dateRange 在 buildQuery 时序列化为 dateFrom/dateTo。
  const [activeFilters, setActiveFilters] = useState<FilterValues>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [form] = Form.useForm<FilterValues>();

  // 拉取项目 + 用户下拉(admin:全部项目;非 admin:可访问项目)。
  useEffect(() => {
    let cancelled = false;
    Promise.all([apiFetch<ProjectOption[]>('/api/projects'), apiFetch<UserOption[]>('/api/users')])
      .then(([p, u]) => {
        if (cancelled) return;
        setProjects(p ?? []);
        setUsers(u ?? []);
      })
      .catch((e: unknown) => {
        // 下拉失败不致命(可空着筛选);仅提示。
        if (!cancelled && e instanceof Error) message.warning(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const buildQuery = useCallback((filters: FilterValues, p: number, size: number): string => {
    const qs = new URLSearchParams();
    if (filters.projectId) qs.set('projectId', filters.projectId);
    if (filters.objectType) qs.set('objectType', filters.objectType);
    if (filters.action) qs.set('action', filters.action);
    if (filters.operatorId) qs.set('operatorId', filters.operatorId);
    if (filters.dateRange?.[0]) qs.set('dateFrom', filters.dateRange[0].format('YYYY-MM-DD'));
    if (filters.dateRange?.[1]) qs.set('dateTo', filters.dateRange[1].format('YYYY-MM-DD'));
    qs.set('limit', String(size));
    qs.set('offset', String((p - 1) * size));
    return `/api/audit-logs?${qs.toString()}`;
  }, []);

  // setLoading 由调用方(初始 state / 事件处理器)负责,函数内只做异步落值。
  const runQuery = useCallback(
    async (filters: FilterValues, p: number, size: number) => {
      setFatal(null);
      try {
        const data = await apiFetch<AuditLogResponse>(buildQuery(filters, p, size));
        setLogs(data.logs);
        setTotal(data.total);
      } catch (e) {
        const err = e as Error & { status?: number };
        if (err.status === 403) {
          setFatal('无权访问操作日志');
        } else {
          setFatal(err.message || '加载操作日志失败');
        }
      } finally {
        setLoading(false);
      }
    },
    [buildQuery],
  );

  // 首次挂载查询一次(loading 已为 true)。effect 内直接发起异步请求,
  // 在 .then/.finally 异步回调里落值,避免 effect body 内同步 setState。
  useEffect(() => {
    let cancelled = false;
    apiFetch<AuditLogResponse>(buildQuery({}, 1, 20))
      .then((data) => {
        if (!cancelled) {
          setLogs(data.logs);
          setTotal(data.total);
        }
      })
      .catch((e: unknown) => {
        const err = e as Error & { status?: number };
        if (!cancelled) {
          setFatal(err.status === 403 ? '无权访问操作日志' : err.message || '加载操作日志失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [buildQuery]);

  const handleQueryClick = async () => {
    let values: FilterValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setActiveFilters(values);
    setPage(1);
    setLoading(true);
    await runQuery(values, 1, pageSize);
  };

  const handleReset = () => {
    form.resetFields();
    const empty: FilterValues = {};
    setActiveFilters(empty);
    setPage(1);
    setLoading(true);
    void runQuery(empty, 1, pageSize);
  };

  const handleTableChange = (pagination: TablePaginationConfig) => {
    const next = pagination.pageSize ?? 20;
    const nextPage = pagination.current ?? 1;
    setPageSize(next);
    setPage(nextPage);
    setLoading(true);
    void runQuery(activeFilters, nextPage, next);
  };

  const columns: ColumnsType<AuditLogRow> = [
    {
      title: '对象类型',
      dataIndex: 'objectType',
      key: 'objectType',
      width: 160,
      render: (t: string) => (
        <Tag>{OBJECT_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t}</Tag>
      ),
    },
    {
      title: '对象编号',
      dataIndex: 'objectId',
      key: 'objectId',
      width: 200,
      ellipsis: true,
      render: (id: string) => (
        <Text copyable code>
          {id.slice(0, 13)}
        </Text>
      ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      key: 'action',
      width: 120,
      render: (a: string) => ACTION_OPTIONS.find((o) => o.value === a)?.label ?? a,
    },
    {
      title: '操作人',
      key: 'operator',
      width: 140,
      render: (_: unknown, r: AuditLogRow) => r.operator?.name ?? r.operatorId.slice(0, 8),
    },
    {
      title: '时间',
      dataIndex: 'operatedAt',
      key: 'operatedAt',
      width: 180,
      render: (s: string) => formatDateTime(s),
    },
  ];

  if (fatal) {
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="error" message={fatal} />
        <Button onClick={() => void runQuery(activeFilters, page, pageSize)}>重试</Button>
      </Space>
    );
  }

  const pagination: TablePaginationConfig = {
    current: page,
    pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: [10, 20, 50, 100],
    showTotal: (n) => `共 ${n} 条`,
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>
        操作日志
      </Title>
      <Text type="secondary">
        审计日志(§14.1):对象类型/对象编号/动作/操作人/时间;展开行查看前后值。
      </Text>

      <Form<FilterValues>
        form={form}
        layout="inline"
        style={{ flexWrap: 'wrap', rowGap: 8, alignItems: 'center' }}
      >
        <Form.Item name="projectId" label="项目">
          <Select<string>
            style={{ width: 220 }}
            allowClear
            placeholder="选择项目"
            options={projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
          />
        </Form.Item>
        <Form.Item name="objectType" label="对象类型">
          <Select<string>
            style={{ width: 180 }}
            allowClear
            placeholder="选择对象类型"
            options={OBJECT_TYPE_OPTIONS}
          />
        </Form.Item>
        <Form.Item name="action" label="动作">
          <Select<string>
            style={{ width: 150 }}
            allowClear
            placeholder="选择动作"
            options={ACTION_OPTIONS}
          />
        </Form.Item>
        <Form.Item name="operatorId" label="操作人">
          <Select<string>
            style={{ width: 180 }}
            allowClear
            placeholder="选择操作人"
            options={users.map((u) => ({ value: u.id, label: u.name }))}
          />
        </Form.Item>
        <Form.Item name="dateRange" label="时间范围">
          <DatePicker.RangePicker style={{ width: 240 }} />
        </Form.Item>
        <Form.Item>
          <Space>
            <Button type="primary" loading={loading} onClick={() => void handleQueryClick()}>
              查询
            </Button>
            <Button onClick={handleReset}>重置</Button>
          </Space>
        </Form.Item>
      </Form>

      <Table<AuditLogRow>
        rowKey="id"
        size="middle"
        loading={loading}
        dataSource={logs}
        columns={columns}
        pagination={pagination}
        onChange={handleTableChange}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '暂无操作日志' }}
        expandable={{
          expandedRowRender: (r) => (
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Card size="small" type="inner" title="变更前(beforeData)">
                <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  {renderJson(r.beforeData)}
                </Paragraph>
              </Card>
              <Card size="small" type="inner" title="变更后(afterData)">
                <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  {renderJson(r.afterData)}
                </Paragraph>
              </Card>
            </Space>
          ),
          rowExpandable: (r) => r.beforeData !== null || r.afterData !== null,
        }}
      />
    </Space>
  );
}
