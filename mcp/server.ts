/**
 * Budget Management MCP Server(stdio)。
 *
 * 把预算系统 REST API 包装为按任务命名的 MCP 工具,供本机 coding agent 接入。
 * 认证:服务账号 API Key(ADR 0001)——读 ~/.budget-agent.json(或
 * BUDGET_CONFIG 指定路径),可用 BUDGET_BASE_URL / BUDGET_TOKEN 环境变量覆盖。
 *
 * 策略(与 AGENTS.md「确认策略」一致):
 * - 自主工具(查询/统计/预览/暂存)随时可用;
 * - 「指令授权」工具(确认导入/新增改记录/到账登记)仅当用户任务指令明确列出时调用;
 * - 硬排除动作(作废/审批/成员管理)不提供工具,且服务端对无人值守凭证直接 403。
 *
 * 运行:npm run mcp(= tsx mcp/server.ts);agent 配置示例:
 *   { "command": "npx", "args": ["-y", "tsx", "<repo>/mcp/server.ts"] }
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

interface AgentConfig {
  baseUrl: string;
  token: string;
}

function loadConfig(): AgentConfig {
  const cfgPath = process.env.BUDGET_CONFIG ?? join(homedir(), '.budget-agent.json');
  let raw: { baseUrl?: string; token?: string } = {};
  try {
    raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    // 无配置文件时仅环境变量生效;两者皆缺才在下方报错。
  }
  // 环境变量逐项覆盖配置文件(可只换 baseUrl 或只换 token,codex P2)。
  const baseUrl = process.env.BUDGET_BASE_URL ?? raw.baseUrl;
  const token = process.env.BUDGET_TOKEN ?? raw.token;
  if (!baseUrl || !token) {
    throw new Error(
      `缺少预算系统凭据:请先创建 ${cfgPath}(内容 {"baseUrl","token"},见 npm run make-agent 输出)` +
        `或设置 BUDGET_BASE_URL / BUDGET_TOKEN 环境变量`,
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

let cached: AgentConfig | null = null;
function config(): AgentConfig {
  cached ??= loadConfig();
  return cached;
}

/** 单次响应文本上限:超过则截断,避免灌爆 agent 上下文。 */
const MAX_TEXT = 48 * 1024;

function clip(text: string): string {
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n…(截断,共 ${text.length} 字符)`
    : text;
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const { baseUrl, token } = config();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const isForm = init?.body instanceof FormData;
  if (init?.body !== undefined && !isForm) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* 保留原文 */
    }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function jsonParams(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** 统一工具返回 */
function out(result: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: clip(JSON.stringify(result, null, 2)) }] };
}

const projectIdDesc = '项目 ID(UUID,可先用 budget_list_projects 查)';

const POLICY_CONFIRM =
  '【指令授权】仅当用户任务指令明确列出该动作(宜点名对象)时才可调用;无人值守任务未经授权调用会被用户视为违规。';
const POLICY_READ = '【自主】查询类工具,随时可用。';

const server = new McpServer({ name: 'budget-management', version: '0.1.0' });

// ---------- 自主(查询/统计/预览/暂存) ----------

server.tool(
  'budget_list_projects',
  `列出全部项目(含编号/名称/归档状态)。${POLICY_READ}`,
  { includeArchived: z.boolean().optional().describe('是否含已归档项目,默认否') },
  async ({ includeArchived }) =>
    out(await api(`/api/projects${includeArchived ? '?includeArchived=1' : ''}`)),
);

server.tool(
  'budget_get_project',
  `取单个项目详情。${POLICY_READ}`,
  { projectId: z.string().uuid().describe(projectIdDesc) },
  async ({ projectId }) => out(await api(`/api/projects/${projectId}`)),
);

server.tool(
  'budget_get_ledger',
  `取项目执行台账(预算 vs 已执行,树形科目扁平数组)。${POLICY_READ}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    year: z.number().int().optional().describe('年度,缺省当前年'),
  },
  async ({ projectId, year }) =>
    out(await api(`/api/projects/${projectId}/ledger${jsonParams({ year })}`)),
);

server.tool(
  'budget_list_records',
  `列项目业务记录(默认不含作废)。${POLICY_READ}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    year: z.number().int().optional(),
    subjectId: z.string().uuid().optional(),
    status: z.enum(['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID']).optional(),
    includeVoid: z.boolean().optional(),
    handler: z.string().optional().describe('经办人包含匹配'),
    summary: z.string().optional().describe('摘要关键词包含匹配'),
    businessDateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    businessDateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  },
  async (p) => {
    const { projectId, ...rest } = p;
    return out(await api(`/api/projects/${projectId}/records${jsonParams(rest)}`));
  },
);

server.tool(
  'budget_get_record_history',
  `取业务记录变更历史。${POLICY_READ}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    recordId: z.string().uuid().describe('业务记录 ID'),
  },
  async ({ projectId, recordId }) =>
    out(await api(`/api/projects/${projectId}/records/${recordId}/history`)),
);

server.tool(
  'budget_list_imports',
  `列项目导入批次(最近 20 条;暂存中的结算单导入可从此继续)。${POLICY_READ}`,
  { projectId: z.string().uuid().describe(projectIdDesc) },
  async ({ projectId }) => out(await api(`/api/projects/${projectId}/imports`)),
);

server.tool(
  'budget_get_import_preview',
  `取导入批次预览(行数据/错误/重复/待指派科目清单)。${POLICY_READ}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    batchId: z.string().uuid().describe('导入批次 ID'),
  },
  async ({ projectId, batchId }) => out(await api(`/api/projects/${projectId}/imports/${batchId}`)),
);

server.tool(
  'budget_get_subject_mappings',
  `取科目映射记忆(项目内「摘要→科目」历史统计,供导入自动指派)。${POLICY_READ}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    q: z.string().optional().describe('摘要包含匹配(不区分大小写)'),
    limit: z.number().int().optional().describe('条数上限,默认 200,最大 500'),
  },
  async ({ projectId, q, limit }) =>
    out(await api(`/api/projects/${projectId}/subject-mappings${jsonParams({ q, limit })}`)),
);

server.tool(
  'budget_monthly_statistics',
  `取项目月度执行统计。${POLICY_READ}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    year: z.number().int().describe('年度'),
  },
  async ({ projectId, year }) =>
    out(await api(`/api/statistics/monthly${jsonParams({ projectId, year })}`)),
);

server.tool(
  'budget_balance_statistics',
  `经费余额统计(总预算口径,可按科目/项目/年度过滤)。${POLICY_READ}`,
  {
    subject: z.string().optional().describe('科目名称/编号模糊,空=全部'),
    projectId: z.string().uuid().optional(),
    year: z.number().int().optional(),
    onlyNegative: z.boolean().optional().describe('仅看结余<0'),
  },
  async (p) => out(await api(`/api/statistics/balance${jsonParams(p)}`)),
);

server.tool(
  'budget_list_audit_logs',
  `查操作审计日志(含无人值守被拒尝试 action=unattended.denied)。${POLICY_READ}`,
  {
    projectId: z.string().uuid().optional(),
    action: z.string().optional(),
    operatorId: z.string().uuid().optional(),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.number().int().optional(),
    offset: z.number().int().optional(),
  },
  async (p) => out(await api(`/api/audit-logs${jsonParams(p)}`)),
);

server.tool(
  'budget_stage_import_rows',
  `暂存结算单导入批次的行级修改(科目指派/年度/强制导入)。批次保持 pending,可反复调用。${POLICY_READ}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    batchId: z.string().uuid().describe('导入批次 ID'),
    updates: z
      .array(
        z.object({
          rowId: z.string().uuid(),
          subjectId: z.string().uuid().nullable().optional().describe('叶科目 ID'),
          budgetYear: z.number().int().optional(),
          forcedImport: z.boolean().optional().describe('对重复行强制导入'),
        }),
      )
      .describe('行级修改数组'),
  },
  async ({ projectId, batchId, updates }) =>
    out(
      await api(`/api/projects/${projectId}/imports/${batchId}`, {
        method: 'PATCH',
        body: JSON.stringify({ updates }),
      }),
    ),
);

// ---------- 指令授权(写操作) ----------

server.tool(
  'budget_upload_import',
  `上传结算单/标准模板 Excel 并解析为导入批次(返回 batchId)。${POLICY_READ}上传本身不改台账;后续确认才生效。`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    filePath: z
      .string()
      .describe('本机 .xlsx 文件绝对路径(如收件箱 ~/budget-inbox/<项目编号>/ 下)'),
  },
  async ({ projectId, filePath }) => {
    const buf = await readFile(filePath);
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([new Uint8Array(buf)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      basename(filePath),
    );
    return out(await api(`/api/projects/${projectId}/imports`, { method: 'POST', body: fd }));
  },
);

server.tool(
  'budget_confirm_import',
  `确认导入批次入账(生成业务记录,不可靠作废以外的方式回退)。${POLICY_CONFIRM}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    batchId: z.string().uuid().describe('导入批次 ID(须已全部指派科目且无阻断错误)'),
  },
  async ({ projectId, batchId }) =>
    out(await api(`/api/projects/${projectId}/imports/${batchId}/confirm`, { method: 'POST' })),
);

server.tool(
  'budget_create_record',
  `新增业务记录。${POLICY_CONFIRM}status 取值:PLACEHOLDER/CONTRACT/FINANCE_APPROVAL/PAID。填了 docNo 且与项目内未作废记录同号 → 409 硬重复,禁止创建(先作废旧记录才能重导);未填 docNo 时若与既有记录构成指纹相似(年度+金额+日期+摘要),响应带 duplicateHints 警示、仍会保存。`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    budgetYear: z.number().int(),
    subjectId: z.string().uuid().describe('叶科目 ID'),
    amount: z.string().describe('金额字符串,如 "1234.56"'),
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    handler: z.string(),
    summary: z.string(),
    status: z.enum(['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID']),
    docNo: z.string().nullable().optional().describe('财务系统单据编号,可空'),
    remark: z.string().nullable().optional(),
  },
  async ({ projectId, ...body }) =>
    out(
      await api(`/api/projects/${projectId}/records`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ),
);

server.tool(
  'budget_update_record',
  `修改业务记录(全部字段可选)。${POLICY_CONFIRM}docNo 改为与未作废记录同号 → 409 硬重复,禁止修改。`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    recordId: z.string().uuid().describe('业务记录 ID'),
    budgetYear: z.number().int().optional(),
    subjectId: z.string().uuid().optional(),
    amount: z.string().optional(),
    businessDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    handler: z.string().optional(),
    summary: z.string().optional(),
    status: z.enum(['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID']).optional(),
    docNo: z.string().nullable().optional(),
    remark: z.string().nullable().optional(),
  },
  async ({ projectId, recordId, ...body }) =>
    out(
      await api(`/api/projects/${projectId}/records/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    ),
);

server.tool(
  'budget_create_receipt',
  `登记到账流水。${POLICY_CONFIRM}`,
  {
    projectId: z.string().uuid().describe(projectIdDesc),
    receiptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: z.string().describe('金额字符串,必须 > 0'),
    summary: z.string().nullable().optional(),
    remark: z.string().nullable().optional(),
  },
  async ({ projectId, ...body }) =>
    out(
      await api(`/api/projects/${projectId}/receipts`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    ),
);

async function main() {
  await server.connect(new StdioServerTransport());
  // stdio 传输:进程生命周期由客户端管理,无需额外 keep-alive。
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
