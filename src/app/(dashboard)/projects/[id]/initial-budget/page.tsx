'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Popconfirm,
  Result,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { apiFetch } from '@/lib/api/client';
import { AmountInput } from '@/components/ui/AmountInput';
import { uuidv7 } from '@/lib/id';

const { Title, Text } = Typography;

/**
 * §6.2 审批状态(与 Prisma ApprovalStatus 同步;不直接引 @prisma/client 以避免在
 * client bundle 里强引运行时枚举)。
 */
type ApprovalStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

const STATUS_META: Record<ApprovalStatus, { label: string; color: string }> = {
  DRAFT: { label: '草稿中', color: 'default' },
  PENDING: { label: '待审批', color: 'processing' },
  APPROVED: { label: '已生效', color: 'success' },
  REJECTED: { label: '已驳回', color: 'error' },
  WITHDRAWN: { label: '已撤回', color: 'warning' },
};

interface ProjectDetail {
  id: string;
  code: string;
  name: string;
}

/** §6 getDraft 返回结构(见 InitialBudgetDraftView)。 */
interface InitialBudgetDraftView {
  id: string;
  projectId: string;
  status: ApprovalStatus;
  projectTotal: string;
  annualBudgets: { year: number; amount: string }[];
  subjects: {
    id: string;
    code: string;
    name: string;
    parentCode: string | null;
    isLeaf: boolean;
    description: string | null;
  }[];
  subjectBudgets: {
    year: number;
    subjectCode: string;
    amount: string;
  }[];
}

/** POST create 的 payload(InitialBudgetPayload)。 */
interface InitialBudgetPayload {
  projectTotal: string;
  annualBudgets: { year: number; amount: string }[];
  subjects: {
    code: string;
    name: string;
    parentCode: string | null;
    isLeaf: boolean;
    description?: string;
  }[];
  subjectBudgets: { year: number; subjectCode: string; amount: string }[];
}

/** 表单内一行年度预算编辑。 */
interface AnnualRow {
  key: string;
  year: number;
  amount: string;
}

/** 表单内一行科目编辑。 */
interface SubjectRow {
  key: string;
  code: string;
  name: string;
  parentCode: string | null;
  /** 不再由用户编辑;在提交时由 leafCodes 推导(无任何行把它作为父即叶)。 */
  isLeaf?: boolean;
  description?: string;
}

/** AntD 树形 Table 的数据节点(在 SubjectRow 之上挂 children)。 */
interface SubjectTreeNode extends SubjectRow {
  key: string;
  children?: SubjectTreeNode[];
}

/** 生成一个简易本地唯一 key(用于列表行的稳定 rowKey)。 */
function genKey(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * 预设预算科目模板(PRD 附录 A 默认预算科目示例)。
 * code 用拼音/英文短码(项目内唯一),parentCode 引用同模板内其它 code;isLeaf 标叶节点。
 * 套用后会替换当前科目树(用户可继续增删改)。
 */
interface TemplateSubject {
  code: string;
  name: string;
  parentCode: string | null;
  isLeaf: boolean;
}

const DEFAULT_SUBJECT_TEMPLATE: TemplateSubject[] = [
  { code: 'ZJF', name: '直接费', parentCode: null, isLeaf: false },
  { code: 'SBF', name: '设备费', parentCode: 'ZJF', isLeaf: false },
  { code: 'SBGZF', name: '设备购置费', parentCode: 'SBF', isLeaf: true },
  { code: 'QTSBF', name: '其他设备费', parentCode: 'SBF', isLeaf: true },
  { code: 'CLF', name: '材料费', parentCode: 'ZJF', isLeaf: true },
  { code: 'WBXZF', name: '外部协作费', parentCode: 'ZJF', isLeaf: true },
  { code: 'RLDLF', name: '燃料动力费', parentCode: 'ZJF', isLeaf: true },
  { code: 'HYCLF', name: '会议、差旅费、国际合作交流费', parentCode: 'ZJF', isLeaf: false },
  { code: 'HYF', name: '会议费', parentCode: 'HYCLF', isLeaf: true },
  { code: 'CLF2', name: '差旅费', parentCode: 'HYCLF', isLeaf: true },
  { code: 'GJHZ', name: '国际合作交流费', parentCode: 'HYCLF', isLeaf: true },
  { code: 'CBWX', name: '出版、文献、信息传播、知识产权事务费', parentCode: 'ZJF', isLeaf: true },
  { code: 'LWF', name: '劳务费', parentCode: 'ZJF', isLeaf: true },
  { code: 'ZJZX', name: '专家咨询费', parentCode: 'ZJF', isLeaf: true },
  { code: 'QTZC', name: '其他支出', parentCode: 'ZJF', isLeaf: true },
  { code: 'JJF', name: '间接费', parentCode: null, isLeaf: false },
  { code: 'KYJX', name: '科研绩效', parentCode: 'JJF', isLeaf: true },
  { code: 'GLF', name: '管理费', parentCode: 'JJF', isLeaf: true },
];

/** 把字符串金额解析为 number(失败/空 → 0);仅用于显示求和提示。 */
function toDisplayNumber(s: string | undefined | null): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export default function InitialBudgetPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [draft, setDraft] = useState<InitialBudgetDraftView | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  // 表单状态。
  const [projectTotal, setProjectTotal] = useState<string>('');
  const [annualRows, setAnnualRows] = useState<AnnualRow[]>([]);
  const [subjectRows, setSubjectRows] = useState<SubjectRow[]>([]);
  // subjectBudgets 以 "subjectCode|year" → amount 的形式持有。
  const [subjectAmounts, setSubjectAmounts] = useState<Record<string, string>>({});

  const [submitting, setSubmitting] = useState(false);

  /** 把 draft 回填到表单状态(DRAFT/REJECTED/WITHDRAWN 可再编辑)。 */
  const hydrateForm = useCallback((d: InitialBudgetDraftView) => {
    setProjectTotal(d.projectTotal);
    setAnnualRows(d.annualBudgets.map((a) => ({ key: genKey(), year: a.year, amount: a.amount })));
    setSubjectRows(
      d.subjects.map((s) => ({
        key: genKey(),
        code: s.code,
        name: s.name,
        parentCode: s.parentCode,
        // isLeaf 不再持久化到行:提交时由 leafCodes 推导。
        description: s.description ?? undefined,
      })),
    );
    const amounts: Record<string, string> = {};
    for (const sb of d.subjectBudgets) {
      amounts[`${sb.subjectCode}|${sb.year}`] = sb.amount;
    }
    setSubjectAmounts(amounts);
  }, []);

  /** 加载项目头 + 编制草稿(仅一次)。 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 项目头是强需求;草稿可能不存在(404 即无草稿)。
        const [proj, draftResult] = await Promise.all([
          apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
          apiFetch<InitialBudgetDraftView | null>(
            `/api/projects/${projectId}/initial-budget`,
          ).catch((e: unknown) => {
            // GET 在无草稿时返回 404(见 getDraft 抛 HTTPError 404)→ 视为无草稿。
            if (e instanceof Error && 'status' in e && (e as { status: number }).status === 404) {
              return null;
            }
            throw e;
          }),
        ]);
        if (cancelled) return;
        setProject(proj);
        if (draftResult) {
          setDraft(draftResult);
          // 预填表单(无论状态,只读态展示也复用同一份数据)。
          hydrateForm(draftResult);
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '加载编制信息失败';
          setFatal(msg);
          if (e instanceof Error) message.error(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, hydrateForm]);

  const status = draft?.status;

  // 可编辑态:无草稿、或草稿处于 DRAFT/REJECTED/WITHDRAWN。
  const editable = !draft || status === 'DRAFT' || status === 'REJECTED' || status === 'WITHDRAWN';

  // ====== 年度预算编辑 ======
  const addAnnualRow = () => {
    setAnnualRows((rs) => [...rs, { key: genKey(), year: new Date().getFullYear(), amount: '' }]);
  };
  const removeAnnualRow = (key: string) => setAnnualRows((rs) => rs.filter((r) => r.key !== key));
  const updateAnnualRow = (key: string, patch: Partial<AnnualRow>) =>
    setAnnualRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  // ====== 科目编辑(树形) ======
  /** 新增根科目:code 用 UUIDv7 自动生成,父为空。 */
  const addRootSubject = () => {
    setSubjectRows((rs) => [...rs, { key: genKey(), code: uuidv7(), name: '', parentCode: null }]);
  };
  /** 在指定行下新增子科目:code 用 UUIDv7,parentCode 指向父 code。 */
  const addChildSubject = (parentKey: string) => {
    setSubjectRows((rs) => {
      const parent = rs.find((r) => r.key === parentKey);
      if (!parent) return rs;
      return [...rs, { key: genKey(), code: uuidv7(), name: '', parentCode: parent.code }];
    });
  };
  /**
   * 删除科目:仅允许删除没有子节点的行(由调用方禁用按钮,此处再防御一次)。
   */
  const removeSubjectRow = (key: string) =>
    setSubjectRows((rs) => {
      const target = rs.find((r) => r.key === key);
      if (!target) return rs;
      const hasChildren = rs.some((r) => r.parentCode === target.code);
      if (hasChildren) return rs; // 有下级 → 不删(防御)。
      return rs.filter((r) => r.key !== key);
    });
  const updateSubjectRow = (key: string, patch: Partial<SubjectRow>) =>
    setSubjectRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /** 套用预设科目模板:替换当前科目树(用户可继续增删改)。
   *  模板自带稳定 code,沿用;isLeaf 不再持久化(提交时推导)。 */
  const applyDefaultTemplate = () => {
    setSubjectRows(
      DEFAULT_SUBJECT_TEMPLATE.map((t) => ({
        key: genKey(),
        code: t.code,
        name: t.name,
        parentCode: t.parentCode,
      })),
    );
    message.success(`已套用预设模板(${DEFAULT_SUBJECT_TEMPLATE.length} 个科目),可在其上继续编辑`);
  };

  const declaredYears = useMemo(() => annualRows.map((r) => r.year), [annualRows]);

  /**
   * 叶节点集合(COMPUTED):一个 code 是叶 ⟺ 没有任何行把它作为 parentCode。
   * 这是判定"金额单元格是否可编辑"的唯一真相源(取代了原 isLeaf Switch)。
   */
  const leafCodes = useMemo(() => {
    const parentCodes = new Set<string>();
    for (const r of subjectRows) {
      if (r.parentCode) parentCodes.add(r.parentCode);
    }
    const leaves = new Set<string>();
    for (const r of subjectRows) {
      if (r.code && !parentCodes.has(r.code)) leaves.add(r.code);
    }
    return leaves;
  }, [subjectRows]);

  /** code → 是否有子节点(用于禁用"删除"按钮)。 */
  const hasChildrenByCode = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of subjectRows) {
      if (r.parentCode) m.set(r.parentCode, true);
    }
    return m;
  }, [subjectRows]);

  const isLeafRow = useCallback((row: SubjectRow) => leafCodes.has(row.code), [leafCodes]);

  /**
   * 把扁平 subjectRows 组装成 AntD Table 树形 dataSource。
   * 根 = parentCode 为空;子按 code 排序保证展示稳定(同 BudgetTreeTable)。
   */
  const subjectTree = useMemo<SubjectTreeNode[]>(() => {
    const byCode = new Map<string, SubjectTreeNode>();
    subjectRows.forEach((r) => byCode.set(r.code, { ...r, key: r.key }));
    const roots: SubjectTreeNode[] = [];
    const sorted = [...byCode.values()].sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    sorted.forEach((node) => {
      if (node.parentCode && byCode.has(node.parentCode)) {
        const parent = byCode.get(node.parentCode)!;
        parent.children = parent.children ?? [];
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  }, [subjectRows]);

  /** §6.4 展示提示:年度合计对比项目总预算。 */
  const annualSum = useMemo(
    () => annualRows.reduce((acc, r) => acc + toDisplayNumber(r.amount), 0),
    [annualRows],
  );
  const projectTotalNum = toDisplayNumber(projectTotal);
  const annualOverTotal = projectTotal !== '' && annualSum > projectTotalNum + 1e-9;

  /** 各年度叶节点合计提示。 */
  const leafSumByYear = useMemo(() => {
    const m = new Map<number, number>();
    for (const [k, amt] of Object.entries(subjectAmounts)) {
      const [code, yearStr] = k.split('|');
      if (!leafCodes.has(code)) continue;
      const year = Number(yearStr);
      m.set(year, (m.get(year) ?? 0) + toDisplayNumber(amt));
    }
    return m;
  }, [leafCodes, subjectAmounts]);

  /** 组装提交 payload。isLeaf 由 leafCodes 在提交时推导。 */
  const buildPayload = (): InitialBudgetPayload => {
    // 仅保留叶子科目的预算,且仅对已声明年度。
    const yearSet = new Set(declaredYears);
    const subjectBudgets: InitialBudgetPayload['subjectBudgets'] = [];
    for (const [k, amt] of Object.entries(subjectAmounts)) {
      const [code, yearStr] = k.split('|');
      const year = Number(yearStr);
      if (!leafCodes.has(code) || !yearSet.has(year)) continue;
      if (amt === '' || amt === undefined) continue;
      subjectBudgets.push({ subjectCode: code, year, amount: amt });
    }
    return {
      projectTotal: projectTotal === '' ? '0.00' : projectTotal,
      annualBudgets: annualRows
        .filter((r) => r.amount !== '' && r.amount !== undefined)
        .map((r) => ({ year: r.year, amount: r.amount })),
      subjects: subjectRows
        .filter((s) => s.code !== '' && s.name !== '')
        .map((s) => ({
          code: s.code,
          name: s.name,
          parentCode: s.parentCode,
          isLeaf: leafCodes.has(s.code),
          ...(s.description ? { description: s.description } : {}),
        })),
      subjectBudgets,
    };
  };

  /**
   * 提交流程(§6):
   * - 仅在无草稿(创建)场景下:POST create → 拿 appId → POST submit → 跳回项目详情。
   * - 若草稿已存在(DRAFT/REJECTED/WITHDRAWN):后端目前没有 update 端点,
   *   仅能对已有 appId 执行 submit(直接流转);此处对 DRAFT 草稿直接提交。
   */
  const handleSaveAndSubmit = async () => {
    setSubmitting(true);
    try {
      let appId: string;
      if (!draft) {
        // 无草稿 → 创建。
        const payload = buildPayload();
        const created = await apiFetch<{ appId: string }>(
          `/api/projects/${projectId}/initial-budget`,
          { method: 'POST', body: JSON.stringify(payload) },
        );
        appId = created.appId;
      } else {
        // 已存在草稿(DRAFT/REJECTED/WITHDRAWAN):先 PATCH 保存最新编辑内容,
        // 把状态置回 DRAFT(§6.2),再提交。
        appId = draft.id;
        const payload = buildPayload();
        await apiFetch<{ appId: string }>(`/api/projects/${projectId}/initial-budget/${appId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      }
      await apiFetch<{ appId: string; status: ApprovalStatus }>(
        `/api/projects/${projectId}/initial-budget/${appId}/submit`,
        { method: 'POST' },
      );
      message.success('已提交,等待审批');
      router.push(`/projects/${projectId}`);
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 仅保存草稿(无草稿场景下先创建,不提交)。
   */
  const handleSaveDraft = async () => {
    setSubmitting(true);
    try {
      const payload = buildPayload();
      if (draft) {
        // 已存在草稿 → PATCH 保存最新编辑(状态置回 DRAFT)。
        await apiFetch<{ appId: string }>(`/api/projects/${projectId}/initial-budget/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        // 无草稿 → 创建。
        await apiFetch<{ appId: string }>(`/api/projects/${projectId}/initial-budget`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      message.success('草稿已保存');
      // 刷新本页,进入"已有草稿(DRAFT)"的可再编辑态。
      const fresh = await apiFetch<InitialBudgetDraftView>(
        `/api/projects/${projectId}/initial-budget`,
      );
      setDraft(fresh);
      hydrateForm(fresh);
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ====== 渲染 ======
  if (loading) return <Skeleton active />;

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

  // 只读态:已生效。
  if (status === 'APPROVED') {
    return (
      <>
        <Title level={3} style={{ marginTop: 0 }}>
          初始预算编制 — {project.name}
        </Title>
        <Space style={{ marginBottom: 16 }}>
          <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
          <Tag color={STATUS_META.APPROVED.color}>{STATUS_META.APPROVED.label}</Tag>
        </Space>
        <Alert
          type="success"
          showIcon
          message="该预算已生效"
          description="如需变更预算,请通过「预算调整」流程进行,初始预算编制不可再修改。"
          style={{ marginBottom: 16 }}
        />
        <ReadOnlyView
          projectTotal={draft?.projectTotal ?? ''}
          annualBudgets={draft?.annualBudgets ?? []}
          subjects={draft?.subjects ?? []}
          subjectBudgets={draft?.subjectBudgets ?? []}
        />
      </>
    );
  }

  // 只读态:待审批。
  if (status === 'PENDING') {
    return (
      <>
        <Title level={3} style={{ marginTop: 0 }}>
          初始预算编制 — {project.name}
        </Title>
        <Space style={{ marginBottom: 16 }}>
          <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
          <Tag color={STATUS_META.PENDING.color}>{STATUS_META.PENDING.label}</Tag>
        </Space>
        <Alert
          type="info"
          showIcon
          message="已提交,等待审批"
          description="该编制单已提交,正在等待审批。审批通过后将自动生效。"
          style={{ marginBottom: 16 }}
        />
        <ReadOnlyView
          projectTotal={draft?.projectTotal ?? ''}
          annualBudgets={draft?.annualBudgets ?? []}
          subjects={draft?.subjects ?? []}
          subjectBudgets={draft?.subjectBudgets ?? []}
        />
      </>
    );
  }

  // 编辑态:无草稿 或 DRAFT/REJECTED/WITHDRAWN。
  // 状态提示条(有草稿且处于被驳回/撤回态时给出说明)。
  const headerTag =
    status === 'REJECTED' || status === 'WITHDRAWN' ? (
      <Tag color={STATUS_META[status].color}>{STATUS_META[status].label}</Tag>
    ) : status === 'DRAFT' ? (
      <Tag color={STATUS_META.DRAFT.color}>{STATUS_META.DRAFT.label}</Tag>
    ) : null;

  return (
    <>
      <Title level={3} style={{ marginTop: 0 }}>
        初始预算编制 — {project.name}
      </Title>

      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
        {headerTag}
      </Space>

      {status === 'REJECTED' && (
        <Alert
          type="error"
          showIcon
          message="该编制单已被驳回,请修改后重新提交。"
          style={{ marginBottom: 16 }}
        />
      )}
      {status === 'WITHDRAWN' && (
        <Alert
          type="warning"
          showIcon
          message="该编制单已撤回,可继续编辑后重新提交。"
          style={{ marginBottom: 16 }}
        />
      )}

      {/* §6.4 提示:年度合计超过总预算(仅展示,后端是真相源)。 */}
      {annualOverTotal && (
        <Alert
          type="error"
          showIcon
          message={`年度预算合计(${annualSum.toFixed(2)})超过项目总预算(${projectTotalNum.toFixed(
            2,
          )}),提交时后端将校验失败。`}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* ====== 第一区:项目总预算 ====== */}
      <Title level={5} style={{ marginTop: 0 }}>
        项目总预算
      </Title>
      <Space style={{ marginBottom: 24 }} align="center">
        <Text type="secondary">总预算金额:</Text>
        <AmountInput
          value={projectTotal || undefined}
          onChange={(v) => setProjectTotal(v ?? '')}
          style={{ width: 240 }}
          disabled={!editable}
          placeholder="0.00"
        />
      </Space>

      {/* ====== 第二区:年度预算 ====== */}
      <Title level={5}>年度预算</Title>
      <Space size="large" style={{ marginBottom: 8 }}>
        <Text type="secondary">
          年度合计:{annualSum.toFixed(2)}
          {projectTotal !== '' && (
            <span style={{ marginLeft: 8 }}>
              / 总预算 {projectTotalNum.toFixed(2)}
              {annualOverTotal ? (
                <Text type="danger" style={{ marginLeft: 8 }}>
                  (超支)
                </Text>
              ) : null}
            </span>
          )}
        </Text>
        {editable && (
          <Button size="small" onClick={addAnnualRow}>
            新增年度
          </Button>
        )}
      </Space>
      <Table<AnnualRow>
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={annualRows}
        locale={{ emptyText: '暂无年度预算,点击「新增年度」' }}
        style={{ marginBottom: 24 }}
        columns={[
          {
            title: '年度',
            dataIndex: 'year',
            width: 200,
            render: (_: unknown, row: AnnualRow) =>
              editable ? (
                <InputNumber
                  min={1900}
                  max={9999}
                  value={row.year}
                  onChange={(v) => updateAnnualRow(row.key, { year: Number(v ?? 0) })}
                  style={{ width: '100%' }}
                />
              ) : (
                `${row.year}`
              ),
          },
          {
            title: '金额',
            dataIndex: 'amount',
            render: (_: unknown, row: AnnualRow) =>
              editable ? (
                <AmountInput
                  value={row.amount || undefined}
                  onChange={(v) => updateAnnualRow(row.key, { amount: v ?? '' })}
                  style={{ width: 240 }}
                />
              ) : (
                <Text>{row.amount}</Text>
              ),
          },
          {
            title: '叶节点合计',
            key: 'leafSum',
            width: 140,
            render: (_: unknown, row: AnnualRow) => {
              const sum = leafSumByYear.get(row.year) ?? 0;
              const annual = toDisplayNumber(row.amount);
              const over = sum > annual + 1e-9;
              return <Text type={over ? 'danger' : undefined}>{sum.toFixed(2)}</Text>;
            },
          },
          ...(editable
            ? [
                {
                  title: '操作',
                  key: 'op',
                  width: 80,
                  render: (_: unknown, row: AnnualRow) => (
                    <Popconfirm title="删除该年度?" onConfirm={() => removeAnnualRow(row.key)}>
                      <Button size="small" type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]
            : []),
        ]}
      />

      {/* ====== 第三区:科目树 + 叶节点预算(树形可编辑表) ====== */}
      <Title level={5}>科目树与叶节点预算</Title>
      <Space size="large" style={{ marginBottom: 8 }}>
        <Text type="secondary">科目数:{subjectRows.length}</Text>
        {editable && (
          <>
            <Button size="small" onClick={addRootSubject}>
              新增根科目
            </Button>
            <Popconfirm
              title="套用预设模板"
              description={
                subjectRows.length > 0
                  ? '将替换当前已编辑的科目树,确认继续?'
                  : '将填入默认预算科目结构(直接费/间接费等),可继续修改。'
              }
              okText="套用"
              cancelText="取消"
              onConfirm={applyDefaultTemplate}
            >
              <Button size="small" type="dashed">
                套用预设模板
              </Button>
            </Popconfirm>
          </>
        )}
      </Space>
      <Table<SubjectTreeNode>
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={subjectTree}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: '暂无科目,点击「新增根科目」' }}
        style={{ marginBottom: 24 }}
        expandable={{ defaultExpandAllRows: true }}
        childrenColumnName="children"
        columns={buildSubjectColumns({
          editable,
          declaredYears,
          subjectAmounts,
          setSubjectAmounts,
          updateSubjectRow,
          addChildSubject,
          removeSubjectRow,
          isLeafRow,
          hasChildrenByCode,
        })}
      />

      {/* ====== 操作按钮 ====== */}
      <Space>
        {!draft && (
          <Button onClick={handleSaveDraft} loading={submitting}>
            保存草稿
          </Button>
        )}
        <Button type="primary" onClick={handleSaveAndSubmit} loading={submitting}>
          {draft ? '提交' : '保存并提交'}
        </Button>
        <Button onClick={() => router.push(`/projects/${projectId}`)}>取消</Button>
      </Space>
    </>
  );
}

// ============================================================
// 子组件:只读视图(PENDING / APPROVED)。
// ============================================================

interface ReadOnlyProps {
  projectTotal: string;
  annualBudgets: { year: number; amount: string }[];
  subjects: {
    id: string;
    code: string;
    name: string;
    parentCode: string | null;
    isLeaf: boolean;
    description: string | null;
  }[];
  subjectBudgets: { year: number; subjectCode: string; amount: string }[];
}

function ReadOnlyView({ projectTotal, annualBudgets, subjects, subjectBudgets }: ReadOnlyProps) {
  const years = annualBudgets.map((a) => a.year);
  const amountFor = (code: string, year: number): string => {
    const hit = subjectBudgets.find((sb) => sb.subjectCode === code && sb.year === year);
    return hit ? hit.amount : '';
  };

  const dynamicYearCols: ColumnsType<ReadOnlyProps['subjects'][number]> = years.map((y) => ({
    title: `${y}`,
    key: `year-${y}`,
    width: 130,
    align: 'right',
    render: (_: unknown, row: ReadOnlyProps['subjects'][number]) => {
      if (!row.isLeaf) {
        return <Text type="secondary">非叶节点</Text>;
      }
      const a = amountFor(row.code, y);
      return a ? <Text>{a}</Text> : <Text type="secondary">—</Text>;
    },
  }));

  const columns: ColumnsType<ReadOnlyProps['subjects'][number]> = [
    { title: '编码', dataIndex: 'code', width: 120 },
    { title: '名称', dataIndex: 'name' },
    {
      title: '父科目',
      dataIndex: 'parentCode',
      width: 140,
      render: (p: string | null) => p ?? <Text type="secondary">(根)</Text>,
    },
    {
      title: '叶节点',
      dataIndex: 'isLeaf',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="blue">叶</Tag> : <Tag>非叶</Tag>),
    },
    ...dynamicYearCols,
  ];

  return (
    <>
      <Space size="large" style={{ marginBottom: 16 }}>
        <Text type="secondary">项目总预算:</Text>
        <Text strong>{projectTotal || '0.00'}</Text>
      </Space>
      <Title level={5}>年度预算</Title>
      <Table
        rowKey="year"
        size="small"
        pagination={false}
        dataSource={annualBudgets}
        style={{ marginBottom: 24 }}
        columns={[
          { title: '年度', dataIndex: 'year', width: 160 },
          {
            title: '金额',
            dataIndex: 'amount',
            align: 'right',
            render: (a: string) => <Text>{a}</Text>,
          },
        ]}
      />
      <Title level={5}>科目树与叶节点预算</Title>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={subjects}
        scroll={{ x: 'max-content' }}
        columns={columns}
      />
    </>
  );
}

// ============================================================
// 子组件:可编辑科目表的列构造。
// (抽到函数里以保持主组件 render 简洁;保留在同一文件内。)
// ============================================================

interface SubjectColumnsArgs {
  editable: boolean;
  declaredYears: number[];
  subjectAmounts: Record<string, string>;
  setSubjectAmounts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  updateSubjectRow: (key: string, patch: Partial<SubjectRow>) => void;
  /** 在指定 key 的行下新增子节点。 */
  addChildSubject: (parentKey: string) => void;
  removeSubjectRow: (key: string) => void;
  /** 推导叶节点判定:code 不被任何行作为 parentCode。 */
  isLeafRow: (row: SubjectRow) => boolean;
  /** code → 是否存在子节点(用于禁用删除)。 */
  hasChildrenByCode: Map<string, boolean>;
}

function buildSubjectColumns(args: SubjectColumnsArgs): ColumnsType<SubjectTreeNode> {
  const {
    editable,
    declaredYears,
    subjectAmounts,
    setSubjectAmounts,
    updateSubjectRow,
    addChildSubject,
    removeSubjectRow,
    isLeafRow,
    hasChildrenByCode,
  } = args;

  const dynamicYearCols: ColumnsType<SubjectTreeNode> = declaredYears.map((y) => ({
    title: `${y}`,
    key: `year-${y}`,
    width: 150,
    align: 'right',
    render: (_: unknown, row: SubjectTreeNode) => {
      if (!editable) {
        const a = subjectAmounts[`${row.code}|${y}`];
        return a ? <Text>{a}</Text> : <Text type="secondary">—</Text>;
      }
      if (!isLeafRow(row)) {
        return <Text type="secondary">非叶节点不可编制</Text>;
      }
      return (
        <AmountInput
          value={subjectAmounts[`${row.code}|${y}`] || undefined}
          onChange={(v) =>
            setSubjectAmounts((prev) => {
              const next = { ...prev };
              if (v === undefined || v === '') {
                delete next[`${row.code}|${y}`];
              } else {
                next[`${row.code}|${y}`] = v;
              }
              return next;
            })
          }
          style={{ width: 140 }}
        />
      );
    },
  }));

  const base: ColumnsType<SubjectTreeNode> = [
    {
      // 名称列即树形首列:AntD 会在该列按层级缩进并显示展开箭头
      // (childrenColumnName="children" + expandable)。
      title: '名称',
      dataIndex: 'name',
      render: (_: unknown, row: SubjectTreeNode) =>
        editable ? (
          <Input
            value={row.name}
            onChange={(e) => updateSubjectRow(row.key, { name: e.target.value })}
            placeholder="如 设备购置费"
          />
        ) : (
          row.name
        ),
    },
    ...dynamicYearCols,
  ];

  if (editable) {
    base.push({
      title: '操作',
      key: 'op',
      width: 180,
      fixed: 'right',
      render: (_: unknown, row: SubjectTreeNode) => {
        const hasChildren = !!hasChildrenByCode.get(row.code);
        const deleteBtn = (
          <Popconfirm
            title="删除该科目?"
            disabled={hasChildren}
            onConfirm={() => removeSubjectRow(row.key)}
          >
            <Button size="small" type="link" danger disabled={hasChildren}>
              删除
            </Button>
          </Popconfirm>
        );
        return (
          <Space size="small">
            <Button size="small" type="link" onClick={() => addChildSubject(row.key)}>
              + 子节点
            </Button>
            {hasChildren ? <Tooltip title="请先删除下级科目">{deleteBtn}</Tooltip> : deleteBtn}
          </Space>
        );
      },
    });
  }

  return base;
}
