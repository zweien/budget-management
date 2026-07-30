'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Result,
  Skeleton,
  Space,
  Statistic,
  Table,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';

import { apiFetch } from '@/lib/api/client';
import { AmountInput } from '@/components/ui/AmountInput';
import { MoneyText } from '@/components/ui/MoneyText';

const { Title, Text } = Typography;

/** 到账记录行(对应 GET /receipts 返回,含 creator 名称)。 */
interface ReceiptRow {
  id: string;
  projectId: string;
  /** 到账日期(ISO 字符串)。 */
  receiptDate: string;
  amount: string;
  summary: string | null;
  remark: string | null;
  creatorId: string;
  createdAt: string;
  creator: { id: string; name: string };
}

interface ReceiptListResponse {
  records: ReceiptRow[];
  /** 到账累计(2 位小数字符串)。 */
  cumulative: string;
}

interface ProjectDetail {
  id: string;
  code: string;
  name: string;
}

/** 把 receiptDate(ISO/带 T)统一为 YYYY-MM-DD 展示。 */
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

/** 新增/修改表单字段。 */
interface ReceiptFormValues {
  receiptDate: dayjs.Dayjs;
  amount: string;
  summary?: string;
  remark?: string;
}

export default function ReceiptsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [records, setRecords] = useState<ReceiptRow[]>([]);
  const [cumulative, setCumulative] = useState<string>('0.00');
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 新增/修改 Modal。
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ReceiptRow | null>(null);
  const [form] = Form.useForm<ReceiptFormValues>();

  // 拉取项目标题(仅一次)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectDetail>(`/api/projects/${projectId}`)
      .then((proj) => {
        if (!cancelled) setProject(proj);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          if (e instanceof Error) message.error(e.message);
          setFatal(e instanceof Error ? e.message : '加载项目信息失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMeta(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /** 拉取到账列表 + 累计。 */
  const reload = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const data = await apiFetch<ReceiptListResponse>(`/api/projects/${projectId}/receipts`);
      setRecords(data.records ?? []);
      setCumulative(data.cumulative ?? '0.00');
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setLoadingRecords(false);
    }
  }, [projectId]);

  // 初次加载 + 项目就绪后拉取列表。
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    apiFetch<ReceiptListResponse>(`/api/projects/${projectId}/receipts`)
      .then((data) => {
        if (!cancelled) {
          setRecords(data.records ?? []);
          setCumulative(data.cumulative ?? '0.00');
        }
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
  }, [projectId, project]);

  /** 打开"新增"Modal。 */
  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ receiptDate: dayjs() });
    setFormOpen(true);
  };

  /** 打开"修改"Modal,预填当前行。 */
  const openEdit = (row: ReceiptRow) => {
    setEditing(row);
    form.setFieldsValue({
      receiptDate: dayjs(row.receiptDate),
      amount: row.amount,
      summary: row.summary ?? undefined,
      remark: row.remark ?? undefined,
    });
    setFormOpen(true);
  };

  /** 提交新增/修改。 */
  const handleSubmit = async () => {
    let values: ReceiptFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // AntD 已在字段下提示。
    }
    const payload = {
      receiptDate: values.receiptDate.format('YYYY-MM-DD'),
      amount: values.amount,
      summary: values.summary ?? null,
      remark: values.remark ?? null,
    };
    setSubmitting(true);
    try {
      if (editing) {
        await apiFetch<{ record: ReceiptRow }>(
          `/api/projects/${projectId}/receipts/${editing.id}`,
          { method: 'PATCH', body: JSON.stringify(payload) },
        );
        message.success('已保存修改');
      } else {
        await apiFetch<{ record: ReceiptRow }>(`/api/projects/${projectId}/receipts`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        message.success('已登记到账');
      }
      setFormOpen(false);
      await reload();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 删除到账记录(二次确认)。 */
  const handleDelete = async (row: ReceiptRow) => {
    try {
      await apiFetch(`/api/projects/${projectId}/receipts/${row.id}`, { method: 'DELETE' });
      message.success('已删除');
      await reload();
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    }
  };

  const columns: ColumnsType<ReceiptRow> = [
    {
      title: '到账日期',
      dataIndex: 'receiptDate',
      key: 'receiptDate',
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
      title: '摘要',
      dataIndex: 'summary',
      key: 'summary',
      ellipsis: true,
      render: (s: string | null) => s || <Text type="secondary">—</Text>,
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      ellipsis: true,
      render: (s: string | null) => s || <Text type="secondary">—</Text>,
    },
    {
      title: '录入人',
      key: 'creator',
      width: 120,
      render: (_: unknown, row: ReceiptRow) => row.creator?.name ?? row.creatorId.slice(0, 8),
    },
    {
      title: '录入时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 150,
      render: (d: string) => formatDateTime(d),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      fixed: 'right',
      render: (_: unknown, row: ReceiptRow) => (
        <Space size={4}>
          <Button size="small" onClick={() => openEdit(row)}>
            修改
          </Button>
          <Popconfirm
            title="确认删除该到账记录?"
            description="到账为参考数据,删除后不可恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => handleDelete(row)}
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
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

  return (
    <>
      <Title level={3} style={{ marginTop: 0 }}>
        到账流水{project ? ` — ${project.name}` : ''}
      </Title>

      <Space wrap style={{ marginBottom: 16 }}>
        <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
        <Button type="primary" onClick={openCreate}>
          登记到账
        </Button>
      </Space>

      {/* 到账累计(参考,§9.1 不作预算上限)。 */}
      <Card size="small" style={{ marginBottom: 16, maxWidth: 320 }}>
        <Statistic
          title="到账累计(参考,不计入预算上限)"
          formatter={() => <MoneyText value={cumulative} riskOnNegative={false} />}
        />
      </Card>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="到账流水仅作参考登记,不参与预算占用或上限校验(§9.1)。"
      />

      <Table<ReceiptRow>
        rowKey="id"
        columns={columns}
        dataSource={records}
        loading={loadingRecords}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
      />

      <Modal
        title={editing ? '修改到账记录' : '登记到账'}
        open={formOpen}
        onOk={handleSubmit}
        onCancel={() => setFormOpen(false)}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        width={520}
      >
        <Form<ReceiptFormValues> form={form} layout="vertical">
          <Form.Item
            name="receiptDate"
            label="到账日期"
            rules={[{ required: true, message: '请选择到账日期' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="amount"
            label="到账金额"
            rules={[{ required: true, message: '请输入到账金额' }]}
          >
            <AmountInput />
          </Form.Item>
          <Form.Item name="summary" label="摘要">
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea maxLength={500} rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
