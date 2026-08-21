<div align="center">

# 预算管理系统 Budget Management System

**科研项目预算的全闭环管理 · 编制 → 下达 → 占用 → 调整 → 统计**

[![Release](https://img.shields.io/badge/release-v0.5.0-blue)](./CHANGELOG.md)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql)](https://www.postgresql.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-38BDF8?logo=tailwindcss)](https://tailwindcss.com/)
[![shadcn/ui](https://img.shields.io/badge/shadcn%2Fui-Radix-000000)](https://ui.shadcn.com/)
[![Tests](https://img.shields.io/badge/tests-229%20passed-brightgreen)](#测试)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

</div>

> 一个面向科研项目的 B/S 架构预算管理工具。围绕 **预算编制 → 预算下达 → 业务占用 → 预算调整 → 统计分析** 的完整闭环，提供精确到科目级的预算管控、实时占用聚合、审批流转与审计留痕。

---

## ✨ 核心特性

- 🔁 **全闭环预算管理** —— 从立项编制到结项统计，覆盖预算的完整生命周期
- 🔐 **Authentik SSO + 三级权限** —— 管理员（全局）/ 普通用户（全局只读）/ 项目负责人（项目级可编辑，成员表驱动）
- 🌳 **树形科目体系** —— 直接费 / 间接费多级科目树，支持自定义科目与预设模板（PRD 附录 A）
- 📊 **实时占用聚合** —— 台账按 `已支出 + 应付未付` 实时计算占用、结余与执行率，无需手动结转
- 💰 **经费余额统计** —— 科目总预算口径的跨项目结余分析，科目名称/编号模糊检索（如"所有项目劳务费结余"）
- 📎 **报销凭证附件** —— 每笔业务可上传附件（图片/PDF/Office，≤50MB 不限数量），在线预览、按科目层级打包下载
- ⚖️ **双维度预算调整** —— 一次调整同时处理「科目总预算」与「年度预算」两个维度，收支平衡校验 + 可调额度锁定
- ✅ **审批流转 + 审计留痕** —— 草稿 / 待审批 / 通过 / 驳回状态机，统一审计中间件记录前后快照
- 🔒 **预算锁机制** —— 调减额度在提交时即锁定，防止多张调整单累计超额
- 📥 **Excel 批量导入** —— 三段式预览（有效 / 错误 / 疑似重复），原子化确认防并发
- 📤 **台账导出** —— 一键导出年度执行台账为 Excel
- 🎨 **Vercel 设计语言** —— 按 DESIGN.md token 体系落地 shadcn/ui 界面，亮 / 暗双主题
- 🔗 **台账联动查询** —— 执行台账点击叶科目直达业务记录筛选视图
- 🎯 **精确金额运算** —— 全链路 `decimal.js` 处理，杜绝浮点误差

## 🧭 预算管理闭环

```mermaid
flowchart LR
    A[预算编制<br/>初始预算 + 科目树] --> B[预算下达<br/>审批生效]
    B --> C[业务占用<br/>逐笔登记支出]
    C --> D{预算调整<br/>双维度调剂}
    D --> B
    C --> E[统计分析<br/>执行率 / 超预算预警]
    E --> F[年度结转<br/>跨年结转未完业务]
    F --> A
```

## 🛠️ 技术栈

| 层           | 技术                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| **前端**     | Next.js 16 (App Router) · React 19 · TypeScript 5 (strict) · Tailwind CSS 4 · shadcn/ui (Radix) · TanStack Table |
| **后端**     | Next.js Route Handlers · Prisma 5 ORM · Zod 校验                                                                 |
| **数据库**   | PostgreSQL 16                                                                                                    |
| **金额运算** | decimal.js（全链路字符串传输，杜绝浮点误差）                                                                     |
| **测试**     | Vitest（229 项集成测试，直连真实 PG）                                                                            |
| **工程化**   | ESLint · Prettier · Husky · commitlint · lint-staged                                                             |

### UI 设计体系

界面遵循 [DESIGN.md](./DESIGN.md)（Vercel 设计语言）token 体系：canvas 分层底色、hairline 边框、ink 主按钮、link 蓝、display 负字距字阶、L1-L5 堆叠阴影；亮 / 暗双主题（next-themes），Geist + Geist Mono 字体（系统中文回落）。表单用 react-hook-form + zod，树表用 TanStack Table，反馈用 sonner toast。

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
docker compose up -d          # PostgreSQL @ localhost:5434
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

### 6.（可选）预算调整导出 docx

预算调整的「导出 docx」功能按模板生成 Word 文档，依赖 `jszip`（已随 `npm install` 安装，纯 Node 实现，无需 Python）。开箱即用，无需额外配置。

> 仓库另附 `scripts/gen_adjustment_docx.py` 作为 Python（python-docx）实现的可选参考，默认未启用。

### 7.（可选）接入 Authentik SSO

默认 `MOCK_AUTH=true`（本地开发用模拟身份）。接入 SSO：在 Authentik 建 OAuth2 Provider(Confidential,Redirect URI `http://localhost:3000/api/auth/callback`)+ Application(slug 建议 `budget`),把凭据填入 `.env` 并设 `MOCK_AUTH=false`，详见 [AGENTS.md](./AGENTS.md) 认证体系小节。首个管理员：`npm run make-admin -- <用户名>`。

> 默认账号（mock 模式，可在顶部切换身份）：
>
> - **张管理**（预算管理员 ADMIN)
> - **李负责人**（普通用户 USER)
> - **王经办人**（普通用户 USER)

## 📖 主要功能

| 模块           | 说明                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| **项目管理**   | 立项、起止时间（可手输日期）、级别、归档；管理员可指定/调整项目负责人（成员管理）                         |
| **预算编制**   | 树形科目编辑器、新编制默认预设模板、单位×数量×单价自动算金额、父节点汇总、草稿随时保存再编辑              |
| **预算审批**   | 提交 / 审批 / 驳回 / 撤回，审批中心统一待办                                                               |
| **预算调整**   | 双维度（总预算 + 年度）联动表单，收支平衡校验，可调额度锁定                                               |
| **业务记录**   | 逐笔登记支出（登记占位 / 合同 / 财务审批 / 已支出），实时占用，连续录入；科目下拉可搜索、同名科目编号消歧 |
| **报销凭证**   | 业务记录附件上传（图片/PDF/Office ≤50MB 不限数量）、抽屉管理、在线预览（浏览器原生渲染）                  |
| **附件打包**   | 按预算科目层级组织 zip 文件夹，文件名模板可自定义（日期/金额/经办人/科目等 8 个占位符），可筛年度         |
| **执行台账**   | 树形展示各科目预算/占用/结余/执行率，列显示控制、导出，叶科目点击直达业务记录筛选                         |
| **到账流水**   | 登记项目到账资金                                                                                          |
| **Excel 导入** | 批量导入业务记录，三段式预览 + 防并发确认                                                                 |
| **年度结转**   | 跨年结转未完成业务记录                                                                                    |
| **统计分析**   | 自定义统计（科目模糊检索）、月度历史、跨项目汇总、**经费余额**（总预算口径结余 + 仅看负结余 + xlsx 导出） |
| **操作日志**   | 全量审计，前后快照留痕                                                                                    |

## 🏗️ 项目结构

```
budget-management/
├── prisma/
│   ├── schema.prisma          # 数据模型(21 个模型)
│   ├── migrations/            # 数据库迁移
│   └── seed.ts                # 种子数据
├── src/
│   ├── app/
│   │   ├── (dashboard)/       # 页面(项目/台账/记录/调整/审批/统计/日志...)
│   │   └── api/               # 54 个 Route Handler
│   ├── components/
│   │   ├── ui/                # shadcn/ui 组件集(含日期/金额/可搜下拉等复合组件)
│   │   ├── records/           # 业务记录域组件(附件抽屉/预览/按科目打包)
│   │   └── layout/            # 布局壳(侧边栏/顶栏/项目 Tab)
│   ├── lib/                   # 预算公式库(占用/可调额度/汇总)、decimal、鉴权
│   └── server/
│       └── services/          # 业务服务(编制/记录/调整/台账/导出/统计/附件...)
└── tests/                     # Vitest 集成测试(31 个文件)
```

## 🧮 关键设计

### 双维度预算调整

一次调整针对某年度，对每个科目同时调整两个维度：

| 科目     | 原总预算 | 总预算调整额 | 调整后总预算 | 原年度预算 | 年度调整额 | 调整后年度预算 |
| -------- | -------- | ------------ | ------------ | ---------- | ---------- | -------------- |
| 材料费   | 60,000   | -10,000      | **50,000**   | 60,000     | -10,000    | **50,000**     |
| 劳务费   | 40,000   | +10,000      | **50,000**   | 40,000     | +10,000    | **50,000**     |
| **汇总** |          | **0** ✓      |              |            | **0** ✓    |                |

- **两维度各自收支平衡**（Σ = 0），提交前强制校验
- 草稿允许不平衡，平衡校验推迟到提交审批
- 审批生效后 `SubjectBudget`（年度）与 `SubjectTotalBudget`（总预算）同步更新

### 实时占用聚合

```
总占用 = 已支出(PAID) + 应付未付(非 PAID 未作废)
可调额度 = 当前预算 - 总占用 - 待审批锁
```

台账的结余、执行率均实时计算，无需定时结转。

### 经费余额统计（v0.5.0）

统计分析页第 4 个 tab，回答"某个科目在所有项目里还剩多少钱"：

```
总结余 = 科目总预算(SubjectTotalBudget,含调整生效额) − 累计总占用
```

- 科目**名称/编号模糊匹配**跨全部项目（如输"劳务"或"LWF"汇总各项目劳务费）
- 命中非叶科目（如"直接费"）时按后代叶科目汇总
- 合计行按命中科目去重叶集合计算，父子科目同时命中不重复计数
- 可选年度切换年度口径（年度预算 − 当年占用）；"仅看结余为负"一击定位风险科目

## 🧪 测试

```bash
npm test                       # 229 项集成测试(直连真实 PostgreSQL)
```

覆盖：编制审批、业务记录、双维度调整（含 §7.4/§7.5 可调额度与安全护栏）、台账上卷、Excel 导入、年度结转、统计（含经费余额口径/模糊匹配/非叶汇总）、附件（上传/打包路径构建/IDOR 防护）、审计快照等。

## 📜 脚本

| 命令                     | 说明                |
| ------------------------ | ------------------- |
| `npm run dev`            | 开发服务器          |
| `npm run build`          | 生产构建            |
| `npm run start`          | 生产启动            |
| `npm test`               | 运行测试            |
| `npm run check-types`    | TypeScript 类型检查 |
| `npm run lint`           | ESLint              |
| `npx prisma migrate dev` | 应用数据库迁移      |
| `npm run db:seed`        | 写入种子数据        |

## 📄 文档

- [产品需求文档 PRD V1.0](./prd/预算管理系统_V1.0_PRD.md)
- [更新日志](./CHANGELOG.md) · [仓库工作约定](./AGENTS.md) · [设计规范](./DESIGN.md)
- 功能设计文档（附件上传 / 按科目打包 / 附件预览）：[docs/superpowers/specs](./docs/superpowers/specs)

## 📝 License

[MIT](./LICENSE)
