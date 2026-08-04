'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, DatePicker, Form, Input, Modal, Space, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';

import { apiFetch } from '@/lib/api/client';

const { Title } = Typography;

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  level: string | null;
  startDate: string | null;
  endDate: string | null;
  remark: string | null;
}

interface CreateFormValues {
  code: string;
  name: string;
  level?: string;
  projectType?: string;
  undertakingUnit?: string;
  range?: [Dayjs, Dayjs];
  remark?: string;
}

export default function ProjectsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  // 初始即为 true,避免 mount effect 内同步 setState(react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<CreateFormValues>();

  const loadProjects = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const data = await apiFetch<ProjectRow[]>('/api/projects');
      setRows(data);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // 首次加载 loading 已为 true,无需同步 setState;后续 setState 均在 await 之后(异步)。
    // 数据拉取是 effect 的合法用途,禁用 set-state-in-effect(本场景无级联渲染风险)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadProjects(false);
  }, []);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(
      (r) => r.code.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
    );
  }, [rows, keyword]);

  const formatDate = (d: string | null) => (d ? dayjs(d).format('YYYY-MM-DD') : '—');

  const columns: ColumnsType<ProjectRow> = [
    { title: '项目编号', dataIndex: 'code', key: 'code', width: 160 },
    { title: '项目名称', dataIndex: 'name', key: 'name' },
    {
      title: '级别',
      dataIndex: 'level',
      key: 'level',
      width: 120,
      render: (v: string | null) => v ?? '—',
    },
    {
      title: '起止时间',
      key: 'period',
      width: 220,
      render: (_, r) => `${formatDate(r.startDate)} ~ ${formatDate(r.endDate)}`,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, r) => (
        <Button type="link" onClick={() => router.push(`/projects/${r.id}`)}>
          查看详情
        </Button>
      ),
    },
  ];

  const handleCreate = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        code: values.code,
        name: values.name,
        level: values.level ?? null,
        projectType: values.projectType ?? null,
        undertakingUnit: values.undertakingUnit ?? null,
        startDate: values.range?.[0]?.toISOString() ?? null,
        endDate: values.range?.[1]?.toISOString() ?? null,
        remark: values.remark ?? null,
      };
      const created = await apiFetch<ProjectRow>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      message.success('项目已创建');
      setModalOpen(false);
      form.resetFields();
      setRows((prev) => [created, ...prev]);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Title level={3} style={{ marginTop: 0 }}>
        项目管理
      </Title>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Input.Search
          placeholder="按项目编号 / 名称搜索"
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ width: 320 }}
        />
        <Button type="primary" onClick={() => setModalOpen(true)}>
          新建项目
        </Button>
      </Space>

      <Table<ProjectRow>
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        pagination={{ pageSize: 10, showSizeChanger: true }}
      />

      <Modal
        title="新建项目"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleCreate}
        confirmLoading={submitting}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form<CreateFormValues> form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="code"
            label="项目编号"
            rules={[{ required: true, message: '请输入项目编号' }]}
          >
            <Input placeholder="系统内唯一" />
          </Form.Item>
          <Form.Item
            name="name"
            label="项目名称"
            rules={[{ required: true, message: '请输入项目名称' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="level" label="级别">
            <Input placeholder="如:国家级 / 省级" />
          </Form.Item>
          <Form.Item name="projectType" label="项目类型">
            <Input placeholder="如:基础研究 / 应用研究" />
          </Form.Item>
          <Form.Item name="undertakingUnit" label="承担单位">
            <Input placeholder="如:XX 研究所" />
          </Form.Item>
          <Form.Item name="range" label="起止时间">
            <DatePicker.RangePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
