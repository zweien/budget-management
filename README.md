<div align="center">

# 预算管理系统 Budget Management System

**科研项目预算的全闭环管理 · 编制 → 下达 → 占用 → 调整 → 统计**

[![Release](https://img.shields.io/badge/release-v0.23.1-blue)](./CHANGELOG.md)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql)](https://www.postgresql.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38BDF8?logo=tailwindcss)](https://tailwindcss.com/)
[![shadcn/ui](https://img.shields.io/badge/shadcn%2Fui-Radix-000000)](https://ui.shadcn.com/)
[![Tests](https://img.shields.io/badge/tests-418%20passed-brightgreen)](#测试)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

> 一个面向科研项目的 B/S 架构预算管理工具。围绕 **预算编制 → 预算下达 → 业务占用 → 预算调整 → 统计分析** 的完整闭环，提供精确到科目级的预算管控、实时占用聚合、审批流转与审计留痕；并内置 **Coding Agent 自动化**——通过 API Key 机器认证 + 分级确认策略，让 AI 代理安全地代管预算。

---

## ✨ 核心特性

- 🔁 **全闭环预算管理** —— 从立项编制到结项统计，覆盖预算的完整生命周期
- 🔐 **Authentik SSO + 两级全局角色** —— 管理员（全局全权）/ 普通用户（全局只读），项目编辑权由成员表驱动（OWNER 可编辑 / HANDLER 录入），与全局角色正交
- 🌳 **树形科目体系** —— 直接费 / 间接费多级科目树，支持自定义科目与预设模板（PRD 附录 A）
- 📦 **双预算类型** —— 一般（科目总预算 + 年度）/ 包干制（总额包干、无科目总预算层），编制 / 调整 / 台账 / 统计口径自动适配
- 🛡️ **重复入账防护** —— 单据编号硬重复全链路拦截（唯一索引兜底、作废释放编号）、疑似重复提示可强制、结算单「补全更新」（ADR 0002）
- 📊 **实时占用聚合** —— 台账按 `已支出 + 应付未付` 实时计算占用、结余与执行率，无需手动结转；列表筛选 / 排序 / 分页 / 合计全部下推 SQL（0.21 性能版）
- 💰 **经费余额统计** —— 科目总预算口径的跨项目结余分析，科目名称/编号模糊检索（如"所有项目劳务费结余"）
- 📎 **报销凭证附件** —— 每笔业务可上传附件（图片/PDF/Office，≤50MB 不限数量），在线预览（近全屏弹窗）、台账附件计数高亮、按科目层级打包下载
- ⚖️ **双维度预算调整** —— 一次调整同时处理「科目总预算」与「年度预算」两个维度，收支平衡校验 + 可调额度锁定
- ✅ **审批流转 + 审计留痕** —— 草稿 / 待审批 / 通过 / 驳回状态机，统一审计中间件记录前后快照
- 🔒 **预算锁机制** —— 调减额度在提交时即锁定，防止多张调整单累计超额
- 📥 **Excel 批量导入** —— 标准模板三段式预览（有效 / 错误 / 疑似重复），原子化确认防并发；**财务结算单** v1/v2/v3 三种版式直接上传（自动识别、单据编号查重、暂存续办）
- 🤖 **Coding Agent 自动化** —— API Key 机器认证（个人凭证自助签发 / 服务账号）、权限 scope 只收窄不放大、无人值守硬排除（作废/审批/成员管理服务端拦截）、MCP Server + Agent Skill + `budget.py` 客户端多层接入
- 📤 **台账导出** —— 一键导出年度执行台账为 Excel；附件 zip 双闸（条数 + 字节）防护
- 🎨 **IDRL 品牌视觉** —— Vercel 设计语言底子 + [zweien/idrl-vi](./docs/idrl-adoption.md) 品牌 token/logo/字体，亮 / 暗双主题
- 🔗 **台账联动查询** —— 执行台账点击叶科目直达业务记录筛选视图
- 🎯 **精确金额运算** —— 全链路 `decimal.js` 处理，杜绝浮点误差

## 🧭 预算管理闭环

```mermaid
flowchart LR
    A[预算编制<br/>初始预算 + 科目树] --> B[预算下达<br/>审批生效]
    B --> C[业务占用<br/>逐笔登记支出]
    C --> D{预算调整<br/>调剂 / 年度编制}
    D --> B
    C --> E[统计分析<br/>执行率 / 超预算预警]
    E --> A
    C -.结算单 Excel.-> G[Agent 自动化<br/>收件箱 → 导入 → 汇报]
    G --> C
```

## 🛠️ 技术栈

| 层             | 技术                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **前端**       | Next.js 16 (App Router) · React 19 · TypeScript 5 (strict) · Tailwind CSS 4 · shadcn/ui (Radix) · TanStack Table                             |
| **后端**       | Next.js Route Handlers · Prisma 5 ORM · Zod 校验                                                                                             |
| **数据库**     | PostgreSQL 16                                                                                                                                |
| **金额运算**   | decimal.js（全链路字符串传输，杜绝浮点误差）                                                                                                 |
| **Agent 接入** | REST API + Bearer API Key · MCP Server (stdio, `@modelcontextprotocol/sdk`) · Agent Skill (`skills/budget-ops`) · `budget.py` 纯标准库客户端 |
| **测试**       | Vitest（418 项集成测试，直连真实 PG）                                                                                                        |
| **工程化**     | ESLint · Prettier · Husky · commitlint · lint-staged                                                                                         |

### UI 设计体系

界面遵循 [DESIGN.md](./DESIGN.md) token 体系：canvas 分层底色、hairline 边框、ink 主按钮、link 蓝、display 负字距字阶、L1-L5 堆叠阴影，并按 [IDRL 品牌化方案](./docs/idrl-adoption.md) 接入品牌 token/logo/字体；亮 / 暗双主题（next-themes）。表单用 react-hook-form + zod，树表用 TanStack Table，反馈用 sonner toast。

## 🚀 快速开始

### 环境要求

- Node.js ≥ 20
- Docker（用于 PostgreSQL）
- pnpm / npm

### 1. 克隆 & 安装

```bash
git clone https://github.com/zweien/budget-management.git
cd budget-management
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 默认配置已可对接 docker-compose 起的 PostgreSQL
```

### 3. 启动数据库

```bash
docker compose up -d          # PostgreSQL @ 127.0.0.1:5434(仅绑本机)
```

### 4. 初始化数据库 & 种子数据

```bash
npx prisma migrate dev     # 应用 Prisma 迁移
npm run db:seed            # 写入 3 个角色用户 + 默认数据
```

### 5. 启动开发服务器

```bash
npm run dev                   # http://localhost:3000
```

### 6.（可选）接入 Authentik SSO

默认 `MOCK_AUTH=true`（本地开发用模拟身份）。接入 SSO：在 Authentik 建 OAuth2 Provider(Confidential,Redirect URI `http://localhost:3000/api/auth/callback`)+ Application(slug 建议 `budget`),把凭据填入 `.env` 并设 `MOCK_AUTH=false`，详见 [AGENTS.md](./AGENTS.md) 认证体系小节。首个管理员：`npm run make-admin -- <用户名>`。

> 默认账号（mock 模式，可在顶部切换身份）：
>
> - **张管理**（预算管理员 ADMIN)
> - **李负责人**（普通用户 USER)
> - **王经办人**（普通用户 USER)

## 🚀 生产部署

> 内网部署（对接已有 Authentik SSO）的完整步骤——Authentik Provider 配置、数据库准备、镜像构建/离线导入、环境变量说明、首个管理员引导与升级流程——见 **[部署指南](./docs/deployment.md)**。

```bash
docker build -t budget-management .
docker run -d -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/budget" \
  -e MOCK_AUTH=false \
  -e AUTHENTIK_ISSUER=… -e AUTHENTIK_CLIENT_ID=… -e AUTHENTIK_CLIENT_SECRET=… \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  -e APP_BASE_URL=https://your-domain \
  budget-management
```

- 容器入口先执行 `prisma migrate deploy`（幂等）再起服务，`RUN_MIGRATIONS=false` 可跳过（改由外部 Job 统一执行）；容器以 `node` 用户运行。
- **红线：非 development 环境 `MOCK_AUTH=true` 会在启动时直接失败**（mock 模式仅凭 `x-mock-user-id` header 即可冒充任意用户，见 `src/instrumentation.ts`）。
- 请求体/导出/上传均有限流闸门：`MAX_BODY_BYTES`（JSON）、`MAX_IMPORT_BYTES`、`MAX_EXPORT_ROWS`、`MAX_EXPORT_TOTAL_BYTES`、`MAX_ATTACHMENT_BYTES`（见 `.env.example`）。
- CI（GitHub Actions）在每次 push/PR 上跑：空库 `prisma migrate deploy`（迁移可执行性）、`check-types`、`lint`、全量 vitest 集成测试（PostgreSQL 16 service 容器）。

## 📖 主要功能

| 模块             | 说明                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **项目管理**     | 立项、起止时间（可手输日期）、级别、归档、**预算类型**（一般 / 包干制，仅空白项目可切换）；管理员可指定/调整项目负责人（成员管理）；归档项目支持**彻底删除**（危险区，输入编号确认，单事务物理删除，拒绝机器凭证）                                                                                                                             |
| **预算编制**     | 树形科目编辑器、新编制默认预设模板、单位×数量×单价自动算金额、父节点汇总、草稿随时保存再编辑                                                                                                                                                                                                                                                   |
| **预算审批**     | 提交 / 审批 / 驳回 / 撤回，审批中心统一待办；行锁复核 + 条件状态更新防审批竞态                                                                                                                                                                                                                                                                 |
| **预算调整**     | 双维度（总预算 + 年度）联动表单，收支平衡校验，可调额度锁定；追加下达兼任**年度预算编制**（余额锚定容量校验：目标年剩余计划 ≤ 项目剩余额度）；驳回后可编辑再提交，审批版本绑定防串版本                                                                                                                                                         |
| **业务记录**     | 逐笔登记支出（登记占位 / 合同 / 财务审批 / 已支出），申请/完成日期、单据编号、批量作废；**统一业务录入页**（跨项目选择→科目联动→连续录入）；表头筛选+排序（日期区间/年份快捷/文本/清单，URL 同步、条件 chips、筛选结果导出）；超预算登记双层红线预警                                                                                           |
| **结算单导入**   | 财务系统结算单 xlsx 直接上传：**v1/v2/v3 三种版式自动识别**；单据编号硬重复拦截（不可强制）、疑似重复提示可强制、**补全更新**（同号金额一致带新信息→只前进更新完成日期/状态）；**v3（2025 导出）明细行粒度**——同号明细（含冲账负数行）按单据合并净额、按「科研项目名称」做多项目映射逐项目入账；科目自动预选（开支细项末段与叶科目名精确相等） |
| **统一导入入口** | `/records/import`：一个入口上传多项目 v3 结算单，自动预映射目标项目；「我的批次」列表暂存续办（最近 20 条）                                                                                                                                                                                                                                    |
| **报销凭证**     | 业务记录附件上传（图片/PDF/Office ≤50MB 不限数量）、抽屉管理、在线预览（近全屏弹窗：图片经 file-viewer 渲染、PDF 走浏览器原生查看器、Office 暂不支持在线预览提示下载）、台账附件计数高亮联动                                                                                                                                                   |
| **附件打包**     | 按预算科目层级组织 zip 文件夹（目录只取科目名称、同级同名自动消歧），文件名模板可自定义（8 个占位符 + 弹窗内含义说明，始终保底原文件扩展名），可筛年度                                                                                                                                                                                         |
| **执行台账**     | 树形展示各科目预算/占用/结余/执行率，**按年度 / 按总预算（跨年度）口径切换**，列显示控制、导出，叶科目点击直达业务记录筛选                                                                                                                                                                                                                     |
| **到账流水**     | 登记项目到账资金                                                                                                                                                                                                                                                                                                                               |
| **Excel 导入**   | 标准模板批量导入业务记录（末列可选单据编号），三段式预览、硬/疑似重复分档、防并发确认                                                                                                                                                                                                                                                          |
| **统计分析**     | 自定义统计（科目模糊检索、明细 14 列对齐录入页、服务端分页）、月度历史、跨项目汇总、**经费余额**（总预算口径结余 + 仅看负结余 + xlsx 导出）                                                                                                                                                                                                    |
| **操作日志**     | 全量审计，前后快照留痕；机器凭证被拒尝试（`unattended.denied` / `apikey.denied`）一并留痕                                                                                                                                                                                                                                                      |
| **API 凭证**     | 个人 API Key 自助签发/撤销：档位（只读/读写/完整）× 项目范围（全部/指定）× 模式（无人值守/在场交互）× 有效期，明文仅创建时可见                                                                                                                                                                                                                 |
| **用户管理**     | 管理员集中管理账号：角色调整（ADMIN/USER）、停用/启用（最后管理员护栏），按用户聚合查看项目成员身份（OWNER/HANDLER）                                                                                                                                                                                                                           |

## 🤖 Coding Agent 自动化

让 AI 编码代理（ZCode / Claude Code 等）安全地代管预算——决策记录见 [ADR 0001](./docs/adr/0001-service-account-api-key.md)。

### 接入层

| 层            | 用法                                                                   | 适用                                          |
| ------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| **HTTP API**  | `Authorization: Bearer bma_…` 调 REST API                              | 通用底座，任何 agent 可用                     |
| **MCP**       | `npm run mcp`（stdio），17 个 `budget_*` 命名工具                      | 本机 agent 的便利层                           |
| **Skill**     | `skills/budget-ops`（已装 `~/.agents/skills/`）                        | 操作手册：策略、流程、汇报格式                |
| **budget.py** | skill 随附的单文件纯标准库 API 客户端（setup / doctor / api / upload） | 无 curl/jq/node_modules 的内网 Windows 客户端 |

### 凭证与权限

- **个人凭证（自助）**：「API 凭证」页签发，权限 = 本人权限 ∩ 凭证范围（**只收窄，不放大**）：
  - 档位：只读（查询统计）/ 读写（加业务记录、导入、到账）/ 完整（与本人相同）
  - 项目范围：全部 / 指定项目（列表接口过滤、跨项目聚合接口拒绝）
  - 模式：无人值守 / 在场交互；有效期：永久 / N 天；创建后不可编辑，要改即撤销重发
- **服务账号**：`npm run make-agent -- <账号名>`，面向长期无人值守定时任务（身份与个人解耦）
- **确认策略三档**（服务端强制 + agent 纪律双层）：

| 档位     | 操作                                                                    | 规则                                  |
| -------- | ----------------------------------------------------------------------- | ------------------------------------- |
| 自主     | 查询 / 统计 / 解析 / 预览 / 暂存 / 科目指派                             | 随时可做                              |
| 指令授权 | 新增改记录 / 确认导入 / 到账 / 初始预算编制 / 调整与下达提交 / 项目创建 | 任务指令明确列出才做                  |
| 硬排除   | 作废 / 审批 / 成员管理 / 项目彻底删除                                   | 无人值守凭证服务端直接 403 + 审计留痕 |

### 无人值守示例

结算单收件箱流程：把财务系统导出的 xlsx 丢进 `~/budget-inbox/<项目编号>/`，agent 定时扫描 → 上传解析 → 按科目映射记忆自动指派科目 → 暂存（或授权后确认导入）→ 成功移 `_done/`、失败移 `_failed/` 并汇报。

```bash
npm run make-agent -- agent-bot    # 建服务账号 + 发 key（明文仅一次，写入 ~/.budget-agent.json）
npm run mcp                        # 启动 MCP stdio server
python skills/budget-ops/budget.py setup   # Windows 客户端交互式配置凭证
```

## 🏗️ 项目结构

```
budget-management/
├── prisma/
│   ├── schema.prisma          # 数据模型(22 个模型)
│   ├── migrations/            # 数据库迁移
│   └── seed.ts                # 种子数据
├── src/
│   ├── app/
│   │   ├── (dashboard)/       # 页面(项目/业务录入/台账/记录/调整/审批/统计/日志/API 凭证...)
│   │   └── api/               # 68 个 Route Handler
│   ├── components/
│   │   ├── ui/                # shadcn/ui 组件集(含日期/金额/可搜下拉等复合组件)
│   │   ├── records/           # 业务记录域组件(附件抽屉/预览/按科目打包/导入预览)
│   │   └── layout/            # 布局壳(侧边栏/顶栏/项目 Tab)
│   ├── lib/                   # 预算公式库(占用/可调额度/汇总)、decimal、鉴权(API Key/权限矩阵)
│   └── server/
│       └── services/          # 业务服务(编制/记录/调整/台账/导出/统计/附件/导入/凭证...)
├── mcp/                       # MCP stdio server(budget_* 工具)
├── skills/budget-ops/         # Coding Agent 操作手册 + budget.py 客户端
├── scripts/                   # make-admin / make-agent / 性能与运维脚本
├── docs/                      # ADR / 部署指南 / 性能报告 / 安全审计 / 设计规格
└── tests/                     # Vitest 集成测试(48 个文件 / 418 项)
```

## 🧮 关键设计

### 双维度预算调整

一次调整针对某年度，对每个科目同时调整两个维度：

| 科目     | 原总预算 | 总预算调整额 | 调整后总预算 | 原年度预算 | 年度调整额 | 调整后年度预算 |
| -------- | -------- | ------------ | ------------ | ---------- | ---------- | -------------- |
| 材料费   | 60,000   | -10,000      | **50,000**   | 60,000     | -10,000    | **50,000**     |
| 劳务费   | 40,000   | +10,000      | **50,000**   | 40,000     | -10,000    | **50,000**     |
| **汇总** |          | **0** ✓      |              |            | **0** ✓    |                |

- **两维度各自收支平衡**（Σ = 0），提交前强制校验
- 草稿允许不平衡，平衡校验推迟到提交审批
- 审批生效后 `SubjectBudget`（年度）与 `SubjectTotalBudget`（总预算）同步更新

### 实时占用聚合

```
总占用 = 已支出(PAID) + 应付未付(非 PAID 未作废)
可调额度 = 当前预算 - 总占用 - 待审批锁
```

台账的结余、执行率均实时计算，无需定时结转；记录/统计列表为服务端分页 + SQL 聚合口径（合计、筛选、排序与页面一致）。

### 经费余额统计

统计分析页第 4 个 tab，回答"某个科目在所有项目里还剩多少钱"：

```
总结余 = 科目总预算(SubjectTotalBudget,含调整生效额) − 累计总占用
```

- 科目**名称/编号模糊匹配**跨全部项目（如输"劳务"或"LWF"汇总各项目劳务费）
- 命中非叶科目（如"直接费"）时按后代叶科目汇总
- 合计行按命中科目去重叶集合计算，父子科目同时命中不重复计数
- 可选年度切换年度口径（年度预算 − 当年占用）；"仅看结余为负"一击定位风险科目

### Agent 权限模型

机器凭证绑定真实用户，**scope 只收窄不放大**：实际权限 = 用户权限 ∩ 凭证范围（档位 × 项目范围），全部拦截统一收口在权限层；无人值守凭证对不可逆动作（作废/审批/成员管理/项目彻底删除）服务端强制 403，被拒尝试全量审计。详见 [AGENTS.md](./AGENTS.md) 与 [ADR 0001](./docs/adr/0001-service-account-api-key.md)。

## 🧪 测试

```bash
npm test                       # 418 项集成测试(48 个文件,直连真实 PostgreSQL)
```

覆盖：编制审批、业务记录、双维度调整（含 §7.4/§7.5 可调额度、余额锚定容量护栏与安全护栏）、包干制口径、重复防护（硬/疑似重复、补全更新、v3 明细合并/多项目映射）、台账上卷与总预算口径、Excel 导入（标准模板 + 结算单 v1/v2/v3 + 统一入口）、统计（含经费余额口径/模糊匹配/非叶汇总）、附件（上传/预览/打包路径构建与同名消歧/zip-slip 拒绝/附件计数）、审计快照、API Key（签发/撤销/过期/硬排除/scope 收窄/科目映射）等。

## 📜 脚本

| 命令                      | 说明                                                      |
| ------------------------- | --------------------------------------------------------- |
| `npm run dev`             | 开发服务器                                                |
| `npm run build` / `start` | 生产构建 / 生产启动                                       |
| `npm test` / `test:watch` | 运行测试（一次 / 监听）                                   |
| `npm run check-types`     | TypeScript 类型检查                                       |
| `npm run lint` / `format` | ESLint / Prettier 格式化                                  |
| `npx prisma migrate dev`  | 应用数据库迁移                                            |
| `npm run db:seed`         | 写入种子数据                                              |
| `npm run make-admin`      | 提升用户为管理员（SSO 首管引导）                          |
| `npm run make-agent`      | 服务账号签发/管理（无人值守场景）                         |
| `npm run mcp`             | 启动 MCP stdio server                                     |
| `npm run perf:*`          | 性能基线（seed/measure/regression/workload/interference） |

## 📄 文档

- [产品需求文档 PRD V1.0](./prd/预算管理系统_V1.0_PRD.md)
- [更新日志](./CHANGELOG.md) · [仓库工作约定](./AGENTS.md) · [设计规范](./DESIGN.md) · [领域术语表](./CONTEXT.md)
- [ADR 0001：服务账号 + API Key 机器认证](./docs/adr/0001-service-account-api-key.md) · [ADR 0002：重复数据防护](./docs/adr/0002-duplicate-prevention.md)
- [生产部署指南（内网 + Authentik SSO）](./docs/deployment.md) · [IDRL 品牌视觉落地](./docs/idrl-adoption.md)
- [性能结果报告](./docs/performance/) · [安全审计清单](./docs/security-audit-run1-checklist.md)
- 功能设计文档（附件上传 / 按科目打包 / 附件预览）：[docs/superpowers/specs](./docs/superpowers/specs)

## 📝 License

[MIT](./LICENSE)
