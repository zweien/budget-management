# AGENTS.md

面向编码代理（与人类协作者）的仓库工作约定。环境类注意事项另见 [CLAUDE.md](./CLAUDE.md)。

## 项目速览

科研项目预算管理系统：Next.js 16(App Router)+ React 19 + Prisma + PostgreSQL,前端 shadcn/ui + Tailwind CSS 4(DESIGN.md token 体系)。常用命令:`npm run dev` / `npm test` / `npm run check-types` / `npm run lint` / `npm run build`。

## 认证与权限(v0.3.0 起)

### 两种模式(`MOCK_AUTH` 切换)

- **`MOCK_AUTH=true`(本地开发/测试默认)**:无登录页;顶栏「模拟用户选择器」切换身份,经 `x-mock-user-id` header 注入,`getCurrentUser()` 读 header。
- **`MOCK_AUTH=false`(SSO)**:Authentik OIDC 授权码流程(`/api/auth/login|callback|logout`),会话为 HttpOnly JWT cookie(`bm_session`,8h,jose HS256);`getCurrentUser()` 验签后**实时查库**(改角色/停用即时生效)。

### 角色模型

- 全局角色只有两级:**`ADMIN`**(全部权限)/ **`USER`**(全局只读:所有项目的台账/记录/统计/审计可见)。
- **项目编辑权由 `ProjectMember` 驱动**:OWNER=可编辑,HANDLER=只读成员;与全局角色正交(USER 成为某项目 OWNER 后即可编辑该项目)。
- 管理入口:项目概览页「成员管理」卡片(仅 ADMIN 可见);API 层由 `requirePermission(user, action, projectId)` 统一拦截(编辑类动作查成员表,其余查全局矩阵)。
- **首次启用 SSO 的管理员引导**:先用 Authentik 账号登录一次(JIT 自动建档为 USER),再 `npm run make-admin -- <用户名>` 提升 ADMIN。

### SSO 环境变量(`MOCK_AUTH=false` 时必填,env.ts 启动校验)

`AUTHENTIK_ISSUER` / `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` / `AUTH_SECRET`(`openssl rand -base64 32`)/ `APP_BASE_URL`。
Authentik 侧:建 OAuth2 Provider(Confidential,Redirect URI `<APP_BASE_URL>/api/auth/callback`,Subject mode=User ID)+ Application(slug 与 ISSUER 路径一致)。

## Coding Agent 自动化(个人凭证 / 服务账号 + API Key)

coding agent 以 API Key 绑定的用户身份经 HTTP API 操作本系统(交互与无人值守皆可)。决策记录见 [docs/adr/0001](./docs/adr/0001-service-account-api-key.md);术语见 [CONTEXT.md](./CONTEXT.md)。

### 凭证与接入

- **个人凭证(自助)**:任意用户在「API 凭证」页(侧边栏)签发/撤销自己的 key,权限 = 本人权限 ∩ 凭证范围(档位 × 项目范围,创建后不可改,可选有效期)。适合交互式与临时任务。
- **服务账号(脚本)**:`npm run make-agent -- <账号名>` 建 USER 账号 + 发无人值守 key;`--attended` 发在场交互 key;`--list` / `--revoke` 管理。适合长期无人值守定时任务(身份与个人解耦)。
- 认证:`Authorization: Bearer bma_…`,`getCurrentUser()` 优先识别(两种 MOCK 模式均可用);凭据写 `~/.budget-agent.json`(chmod 600),`BUDGET_BASE_URL`/`BUDGET_TOKEN` 可覆盖。
- MCP:`npm run mcp`(stdio,`mcp/server.ts`,工具名 `budget_*`,策略写在工具描述里);Skill:仓库 `skills/budget-ops/`(已装 `~/.agents/skills/budget-ops/`)——skill 以 HTTP 为准、不依赖 MCP。
- 项目授权:个人凭证跟随本人成员关系;服务账号由 ADMIN 在「成员管理」加入项目(OWNER 可编辑)。

### 凭证范围(scope 只收窄,不放大)

| 维度     | 取值                | 语义                                                                                                                    |
| -------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 档位     | 只读 / 读写 / 完整  | 只读=查询统计;读写=加业务记录、导入、到账;完整=与本人相同                                                               |
| 项目范围 | 全部 / 指定项目     | 指定后:其他项目上下文 403;跨项目/无项目上下文接口(统计、审计全量、审批待办、用户列表、建项目)403;项目列表仅返回指定项目 |
| 模式     | 无人值守 / 在场交互 | 无人值守时,作废/审批/成员管理被服务端拒绝                                                                               |
| 有效期   | 永久 / N 天         | 过期后凭证即失效(401)                                                                                                   |

被拒尝试写审计:硬排除 `action=unattended.denied`,scope 收窄 `action=apikey.denied`。
**红线:凭证管理接口(`/api/api-keys*`)拒绝一切 Bearer 凭证调用(含 attended)——防 agent 自我签发凭证。**

### 确认策略(agent 会话必须遵守;操作目录见 skill)

| 档位     | 操作                                                                   | 规则                                                                                                 |
| -------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 自主     | 查询/统计/审计/解析/预览/暂存/科目指派                                 | 随时可做                                                                                             |
| 指令授权 | 新增改记录、确认导入、到账登记、调整编制提交                           | 任务指令明确列出才做                                                                                 |
| 硬排除   | 作废(`record:void`)、审批(`budget:approve`)、成员管理(`member:manage`) | 无人值守凭证服务端直接 403(`UNATTENDED_EXCLUDED_ACTIONS`),被拒尝试进审计(`action=unattended.denied`) |

### 无人值守约定

- 收件箱:`~/budget-inbox/<项目编号>/*.xlsx`,成功移 `_done/`、失败移 `_failed/`(附原因 txt)。
- 科目自动指派:`GET /api/projects/:id/subject-mappings`(摘要→科目历史统计)+ agent 语义判断;拿不准留暂存并汇报待指派,不强行确认。
- 重复防护([ADR 0002](./docs/adr/0002-duplicate-prevention.md)):所有写入口统一查重——单据编号与项目内未作废记录同号 = **硬重复**,服务端 409/422 拒绝、无强制通道;无编号行按指纹(年度+金额+日期+摘要)疑似提示,导入预览可人工强制。DB 部分唯一索引兜底;作废记录不占编号(撤销后可重导)。**唯一例外「补全更新」**:结算单导入(v1/v2)中同号行与既有记录**金额一致**且带来新信息(补完成日期缺口 / 状态推进到已支出)时,确认后**更新**既有记录的完成日期/状态(状态只前进,金额/科目/摘要不改)——完成日期以财务系统后续导出为准。

## 版本发布流程(确保版本号唯一)

**唯一事实源:`package.json` 的 `version` 字段;git tag `vX.Y.Z` 与其一一对应。**
侧边栏版本号与 `/changelog` 页自动跟随,无需手改前端。

### 何时 bump(conventional commits ↔ semver)

| 变更类型                          | bump      |
| --------------------------------- | --------- |
| `fix`(缺陷修复)                   | **patch** |
| `feat`(新功能,向后兼容)           | **minor** |
| 破坏性变更(`BREAKING CHANGE`/`!`) | **major** |

### 发布步骤(在 `main` 上执行)

```bash
# 1. 确认工作区干净、main 与远端同步
git status && git pull

# 2. 更新 CHANGELOG.md:为即将发布的版本新增一节
#    ## [X.Y.Z] - YYYY-MM-DD(新增/变更/修复)

# 3. 唯一性预检:目标 tag 不得已存在
git fetch --tags
git tag -l "vX.Y.Z"   # 有输出 = 已被占用,换版本号

# 4. npm version 自动:bump package.json + 提交 + 打 tag
npm version patch   # 或 minor / major

# 5. 推送提交与 tag
git push --follow-tags
```

### 硬性规则

- **禁止手改 `package.json` 的 `version`**——必须经过 `npm version`,否则没有对应 git tag,唯一性无从校验。
- **禁止跳过 CHANGELOG.md**——每个版本节先于 `npm version` 提交;`/changelog` 页直接渲染它,漏写即漏公示。
- **tag 即唯一锁**:`npm version` 生成的 `vX.Y.Z` tag 若已存在,第 5 步推送会被远端拒绝,此时说明版本号撞车,换号重来;不要强推覆盖 tag。
- 功能分支上不执行 `npm version`;合并入 `main` 后才发版,保证 tag 指向主干历史。
- 预发布用 `npm version prepatch --preid=beta`(产出 `vX.Y.Z-beta.0`),不占正式号段。
