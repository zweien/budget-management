'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Result,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';

import { apiFetch } from '@/lib/api/client';

const { Title, Text } = Typography;

interface ProjectRef {
  id: string;
  code: string;
  name: string;
}
interface UserRef {
  id: string;
  name: string;
}

interface InitialBudgetPending {
  id: string;
  projectId: string;
  status: string;
  applicantId: string;
  createdAt: string;
  updatedAt: string;
  project: ProjectRef;
  applicant: UserRef;
}

interface AdjustmentPending {
  id: string;
  projectId: string;
  year: number;
  status: string;
  reason: string | null;
  applicantId: string;
  createdAt: string;
  updatedAt: string;
  project: ProjectRef;
  applicant: UserRef;
  lineCount?: number;
}

interface SubjectChangePending {
  id: string;
  projectId: string;
  status: string;
  applicantId: string;
  createdAt: string;
  updatedAt: string;
  project: ProjectRef;
  applicant: UserRef;
}

interface PendingResponse {
  initialBudgets: InitialBudgetPending[];
  adjustments: AdjustmentPending[];
  subjectChanges: SubjectChangePending[];
}

type ApproveTarget =
  | { kind: 'initialBudget'; row: InitialBudgetPending }
  | { kind: 'adjustment'; row: AdjustmentPending }
  | { kind: 'subjectChange'; row: SubjectChangePending };

interface OpinionFormValues {
  opinion: string;
}

const formatDateTime = (s: string | null): string => {
  if (!s) return '—';
  const d = dayjs(s);
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : '—';
};

export default function ApprovalsPage() {
  const [data, setData] = useState<PendingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // 审批/驳回 Modal。
  const [target, setTarget] = useState<ApproveTarget | null>(null);
  const [mode, setMode] = useState<'approve' | 'reject'>('approve');
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<OpinionFormValues>();

  const loadPending = useCallback(async () => {
    setLoading(true);
    setFatal(null);
    try {
      const result = await apiFetch<PendingResponse>('/api/approvals/pending');
      setData(result);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 403) {
        setForbidden(true);
      } else {
        setFatal(err.message || '加载待办失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 首次加载 loading 已为 true,无需同步 setState。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPending();
  }, [loadPending]);

  const openAction = (next: ApproveTarget, nextMode: 'approve' | 'reject') => {
    setTarget(next);
    setMode(nextMode);
    form.resetFields();
  };

  const closeAction = () => {
    setTarget(null);
    form.resetFields();
  };

  const submitAction = async () => {
    if (!target) return;
    let values: OpinionFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const opinion = values.opinion?.trim() ?? '';
    if (mode === 'reject' && !opinion) {
      message.error('驳回必须填写意见');
      return;
    }

    setSubmitting(true);
    try {
      const { kind, row } = target;
      const projectId = row.projectId;
      const segments: { kind: ApproveTarget['kind']; action: string; path: string }[] = [
        {
          kind: 'initialBudget',
          action: mode,
          path: `/api/projects/${projectId}/initial-budget/${row.id}/${mode}`,
        },
        {
          kind: 'adjustment',
          action: mode,
          path: `/api/projects/${projectId}/adjustments/${row.id}/${mode}`,
        },
        {
          kind: 'subjectChange',
          action: mode,
          path: `/api/projects/${projectId}/subject-changes/${row.id}/${mode}`,
        },
      ];
      const match = segments.find((s) => s.kind === kind);
      if (!match) throw new Error('未知待办类型');
      await apiFetch(match.path, {
        method: 'POST',
        body: JSON.stringify({ opinion }),
      });
      message.success(mode === 'approve' ? '已审批通过' : '已驳回');
      closeAction();
      await loadPending();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (forbidden) {
    return (
      <Result
        status="403"
        title="无权访问审批中心"
        subTitle="审批中心仅对预算管理员(BUDGET_ADMIN)开放。请在右上角切换为管理员身份。"
      />
    );
  }

  if (fatal) {
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="error" message={fatal} />
        <Button onClick={() => void loadPending()}>重试</Button>
      </Space>
    );
  }

  const initialColumns: ColumnsType<InitialBudgetPending> = [
    { title: '项目', key: 'project', render: (_, r) => `${r.project.code} · ${r.project.name}` },
    { title: '申请人', key: 'applicant', render: (_, r) => r.applicant.name },
    { title: '提交时间', key: 'updatedAt', render: (_, r) => formatDateTime(r.updatedAt) },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_, r) => (
        <Space>
          <Button
            size="small"
            type="primary"
            onClick={() => openAction({ kind: 'initialBudget', row: r }, 'approve')}
          >
            审批
          </Button>
          <Button
            size="small"
            danger
            onClick={() => openAction({ kind: 'initialBudget', row: r }, 'reject')}
          >
            驳回
          </Button>
        </Space>
      ),
    },
  ];

  const adjustmentColumns: ColumnsType<AdjustmentPending> = [
    { title: '项目', key: 'project', render: (_, r) => `${r.project.code} · ${r.project.name}` },
    {
      title: '年度',
      key: 'year',
      width: 80,
      render: (_, r) => `${r.year}`,
    },
    {
      title: '明细数',
      key: 'lines',
      width: 80,
      render: (_, r) => r.lineCount ?? '—',
    },
    {
      title: '原因',
      key: 'reason',
      ellipsis: true,
      render: (_, r) => r.reason ?? '—',
    },
    { title: '申请人', key: 'applicant', render: (_, r) => r.applicant.name },
    { title: '提交时间', key: 'updatedAt', render: (_, r) => formatDateTime(r.updatedAt) },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_, r) => (
        <Space>
          <Button
            size="small"
            type="primary"
            onClick={() => openAction({ kind: 'adjustment', row: r }, 'approve')}
          >
            审批
          </Button>
          <Button
            size="small"
            danger
            onClick={() => openAction({ kind: 'adjustment', row: r }, 'reject')}
          >
            驳回
          </Button>
        </Space>
      ),
    },
  ];

  const subjectChangeColumns: ColumnsType<SubjectChangePending> = [
    { title: '项目', key: 'project', render: (_, r) => `${r.project.code} · ${r.project.name}` },
    { title: '申请人', key: 'applicant', render: (_, r) => r.applicant.name },
    { title: '提交时间', key: 'updatedAt', render: (_, r) => formatDateTime(r.updatedAt) },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_, r) => (
        <Space>
          <Button
            size="small"
            type="primary"
            onClick={() => openAction({ kind: 'subjectChange', row: r }, 'approve')}
          >
            审批
          </Button>
          <Button
            size="small"
            danger
            onClick={() => openAction({ kind: 'subjectChange', row: r }, 'reject')}
          >
            驳回
          </Button>
        </Space>
      ),
    },
  ];

  const initialCount = data?.initialBudgets.length ?? 0;
  const adjustmentCount = data?.adjustments.length ?? 0;
  const subjectChangeCount = data?.subjectChanges.length ?? 0;

  const targetRow = target?.row;
  const targetProjectLabel = targetRow
    ? `${targetRow.project.code} · ${targetRow.project.name}`
    : '';

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Title level={3} style={{ margin: 0 }}>
        审批中心
      </Title>
      <Text type="secondary">汇总待审批的初始预算编制、预算调整与科目变更。</Text>

      <Tabs
        defaultActiveKey="initialBudget"
        items={[
          {
            key: 'initialBudget',
            label: (
              <span>
                初始预算编制{' '}
                <Tag color={initialCount ? 'processing' : 'default'}>{initialCount}</Tag>
              </span>
            ),
            children: (
              <Table<InitialBudgetPending>
                rowKey="id"
                size="middle"
                loading={loading}
                dataSource={data?.initialBudgets ?? []}
                columns={initialColumns}
                pagination={false}
                locale={{ emptyText: '暂无待审批编制单' }}
              />
            ),
          },
          {
            key: 'adjustment',
            label: (
              <span>
                预算调整{' '}
                <Tag color={adjustmentCount ? 'processing' : 'default'}>{adjustmentCount}</Tag>
              </span>
            ),
            children: (
              <Table<AdjustmentPending>
                rowKey="id"
                size="middle"
                loading={loading}
                dataSource={data?.adjustments ?? []}
                columns={adjustmentColumns}
                pagination={false}
                locale={{ emptyText: '暂无待审批调整单' }}
              />
            ),
          },
          {
            key: 'subjectChange',
            label: (
              <span>
                科目变更{' '}
                <Tag color={subjectChangeCount ? 'processing' : 'default'}>
                  {subjectChangeCount}
                </Tag>
              </span>
            ),
            children: (
              <Table<SubjectChangePending>
                rowKey="id"
                size="middle"
                loading={loading}
                dataSource={data?.subjectChanges ?? []}
                columns={subjectChangeColumns}
                pagination={false}
                locale={{ emptyText: '暂无待审批科目变更单' }}
              />
            ),
          },
        ]}
      />

      <Modal
        title={mode === 'approve' ? '审批通过' : '驳回'}
        open={!!target}
        onOk={() => void submitAction()}
        onCancel={closeAction}
        confirmLoading={submitting}
        okText={mode === 'approve' ? '确认通过' : '确认驳回'}
        okButtonProps={mode === 'reject' ? { danger: true } : undefined}
        destroyOnHidden
      >
        {targetRow && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text>项目:{targetProjectLabel}</Text>
            <Text>申请人:{targetRow.applicant.name}</Text>
            <Form form={form} layout="vertical">
              <Form.Item
                name="opinion"
                label="审批意见"
                rules={
                  mode === 'reject' ? [{ required: true, message: '请填写驳回意见' }] : undefined
                }
              >
                <Input.TextArea
                  rows={3}
                  placeholder={mode === 'approve' ? '可选填写意见' : '请填写驳回原因'}
                />
              </Form.Item>
            </Form>
          </Space>
        )}
      </Modal>
    </Space>
  );
}
