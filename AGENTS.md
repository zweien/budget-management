# AGENTS.md

面向编码代理（与人类协作者）的仓库工作约定。环境类注意事项另见 [CLAUDE.md](./CLAUDE.md)。

## 项目速览

科研项目预算管理系统：Next.js 16(App Router)+ React 19 + Prisma + PostgreSQL,前端 shadcn/ui + Tailwind CSS 4(DESIGN.md token 体系)。常用命令:`npm run dev` / `npm test` / `npm run check-types` / `npm run lint` / `npm run build`。

## 认证与权限(v0.3.0 起)

### 两种模式(`MOCK_AUTH` 切换)

- **`MOCK_AUTH=true`(本地开发/测试默认)**:无登录页;顶栏「模拟用户选择器」切换身份,经 `x-mock-user-id` header 注入,`getCurrentUser()` 读 header。
- **`MOCK_AUTH=false`(SSO)**:登录页按已配置提供方渲染入口,两组提供方可并存、**至少配一组**(env 启动校验,半配置报错):
  - **Authentik OIDC**:`/api/auth/login|callback|logout`,授权码 + PKCE;登出走 Authentik end-session(id_token_hint)。
  - **钉钉扫码**(v0.35.0 起,`src/lib/auth/dingtalk.ts`):`/api/auth/dingtalk/login|callback`,OAuth2 授权码换 `userAccessToken` 取 `unionId`;无 id_token,登出仅清本地会话。身份键 `dingtalk:<unionId>` 与 Authentik sub 共用 `users.auth_subject` 唯一列——**同一人经两提供方登录为两个独立账号,不做自动关联**。
  - 会话均为 HttpOnly JWT cookie(`bm_session`,8h,jose HS256);`getCurrentUser()` 验签后**实时查库**(改角色/停用即时生效)。

### 角色模型

- 全局角色只有两级:**`ADMIN`**(全部权限)/ **`USER`**(全局只读:所有项目的台账/记录/统计/审计可见)。
- **项目编辑权由 `ProjectMember` 驱动**:OWNER=可编辑(预算/项目维护/作废),HANDLER=录入人员(可录记录/导入/到账,不可改预算);与全局角色正交(USER 成为某项目 OWNER 后即可编辑该项目)。
- 管理入口:项目概览页「成员管理」卡片(仅 ADMIN 可见);API 层由 `requirePermission(user, action, projectId)` 统一拦截(编辑类动作查成员表,其余查全局矩阵)。
- **首次启用 SSO 的管理员引导**:先用 Authentik 账号登录一次(JIT 自动建档为 USER),再 `npm run make-admin -- <姓名/显示名 或 SSO sub(UUID)>` 提升 ADMIN(回调显示名优先建档时登录名不入库,脚本对 UUID 输入同时匹配本地 id / authSubject / name)。

### SSO 环境变量(`MOCK_AUTH=false` 时,env.ts 启动校验)

`AUTH_SECRET`(`openssl rand -base64 32`)与 `APP_BASE_URL` 必填;提供方至少配一组(按组整体配置,不允许半配置):

- **Authentik 三件套**:`AUTHENTIK_ISSUER` / `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET`。Authentik 侧:建 OAuth2 Provider(Confidential,Redirect URI `<APP_BASE_URL>/api/auth/callback`,Subject mode=User ID)+ Application(slug 与 ISSUER 路径一致)。
- **钉钉两件套**:`DINGTALK_CLIENT_ID`(AppKey)/ `DINGTALK_CLIENT_SECRET`(AppSecret)。钉钉开放平台侧:应用的登录回调域名须包含部署域名,重定向 URL = `<APP_BASE_URL>/api/auth/dingtalk/callback`。

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
**同类红线:用户管理(`/api/admin/users*`)、系统设置写入(`PATCH /api/settings`,见下文「系统设置」)与项目彻底删除(`/api/projects/:id/purge`,须先归档、输入编号确认)同样拒绝一切 Bearer 凭证、仅限管理员登录会话。**

### 确认策略(agent 会话必须遵守;操作目录见 skill)

| 档位     | 操作                                                                                                   | 规则                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 自主     | 查询/统计/审计/解析/预览/暂存/科目指派                                                                 | 随时可做                                                                                             |
| 指令授权 | 新增改记录、确认导入、到账登记、调整编制提交、附件上传(含批量)                                         | 任务指令明确列出才做                                                                                 |
| 硬排除   | 作废(`record:void`)、审批(`budget:approve`)、成员管理(`member:manage`)、项目彻底删除(`project:delete`) | 无人值守凭证服务端直接 403(`UNATTENDED_EXCLUDED_ACTIONS`),被拒尝试进审计(`action=unattended.denied`) |

### 无人值守约定

- 收件箱:`~/budget-inbox/<项目编号>/*.xlsx`,成功移 `_done/`、失败移 `_failed/`(附原因 txt)。
- 科目自动指派:`GET /api/projects/:id/subject-mappings`(摘要→科目历史统计)+ agent 语义判断;拿不准留暂存并汇报待指派,不强行确认。
- 重复防护([ADR 0002](./docs/adr/0002-duplicate-prevention.md)):所有写入口统一查重——单据编号与项目内未作废记录同号 = **硬重复**,服务端 409/422 拒绝、无强制通道;无编号行按指纹(年度+金额+日期+摘要)疑似提示,导入预览可人工强制。DB 部分唯一索引兜底;作废记录不占编号(撤销后可重导)。**金额规则(0.45.0 起)**:各录入/导入入口允许**负数金额 = 冲正记录**(财务更正业务,如报销错科目;照常入账冲减科目占用),金额为 0 一律拒绝。**唯一例外「补全更新」**:结算单导入(v1/v2/v3)中同号行与既有记录**金额一致**且带来新信息(补完成日期缺口 / 状态可回写)时,确认后**更新**既有记录的完成日期/状态(金额/科目/摘要不改)——完成日期以财务系统后续导出为准;状态回写规则:**已支出是终态、不回退**,其余状态随财务系统回写(推进到已支出,或在途 ↔ 业务退单 双向),两个在途态之间互改不算新信息(仍硬重复)。**业务退单**:各版式结算单的「业务退单」行不再跳过,照常入账为业务状态 `RETURNED`(计入应付未付,与其余在途态同口径);系统模板的「业务状态」列、手动录入与状态切换同样支持。财务结算单 v3(2025 导出)为明细行粒度:同号明细(冲账重报,含负数行)先按单据合并(金额取组内代数和净额)再进入查重,批内同号不触发硬重复;净额为 0 的纯冲销单整组跳过,净额为负即冲正记录照常入账。v3 文件可含多个项目:按「科研项目名称」做**项目映射**(自动预映射=去口径前缀后唯一包含某项目名,未命中人工指定),逐目标项目要求导入权限并分别查重入账。单据台账 v4(33 列,`settlement-3.0`)为**单据**粒度一行一单:净额 = 报销金额(元) − 冲销金额(元)(=0 纯冲销跳过,<0 冲正入账),年度取「年度」列、业务日期 = 填报日期、完成日期可为 ISO 时间戳(截日期);「项目」「控制项」与 v3 的 科研项目名称/开支细项名称 同语义(映射/末段预选科目),统一入口与查重/补全更新管线同 v3。注意:项目改名(脱敏后缀)会使财务文件原名不再包含系统项目名,自动预映射退化为人工指定。

## 系统设置(ADR 0004)

管理员在侧边栏「系统设置」(`/settings`)维护全实例统一的展示信息与默认值;个人在浏览器里做过的选择(主题切换、侧边栏折叠、执行率分级线)始终优先于系统默认(术语见 CONTEXT.md「系统设置 / 个人偏好」)。

- **设置项**:系统标题与副标题、系统标志(标准版 / 深色主题版 / 窄栏图标版,未设置的版本回退到标准版,全部清除即恢复内置标志)、登录页提示、关于页系统简介、页脚文字、默认主题、台账默认口径与年度、执行率分级线默认值、侧边栏默认折叠。未配置的项呈现内置默认(= 引入前的行为,不改设置就没有任何变化)。
- **单一事实源**:`src/lib/system-settings.ts`——出厂默认、各键校验、标志回退规则。新增设置项 = 在此加一个键 + 设置页加字段,**不动表结构**(标量存单例行的稀疏 JSON,标志字节另表)。标志文件校验在 `src/lib/system-logo.ts`(PNG / WebP / SVG,≤512KB,按文件内容识别,SVG 禁脚本/事件属性/外部引用)。
- **读取匿名可读**:`GET /api/settings` 与标志路由 `GET /api/settings/logos/:key` 不要求登录——登录页在认证前就要渲染标题与标志。**边界:只放「匿名可见无害」的展示类设置;敏感配置(密钥、策略阈值、内部地址)不得进入,必要时另开需鉴权的接口。**
- **生效时机**:保存后其他人下次刷新或跳转生效,不做实时推送。设置是实例级数据:进快照备份,不进迁移包。修改写审计(`objectType=system_settings`,`action=settings.update`;标志只记类型与大小)。

## 备份与迁移(ADR 0003)

两档产物,职责与保密属性相反(词汇表见 CONTEXT.md「备份与迁移」):

- **快照备份** = pg_dump 全库(含用户/凭证哈希/审计),**同环境灾难恢复用,敏感不可外传**;`.env` 不入包。
- **迁移包** = 单项目「项目+预算骨架」JSON(**不含**用户/成员/业务记录/到账/附件/审计),跨环境导入用;项目编号为幂等键,保留原 ID。

命令(均在本机 CLI 执行):

```bash
npm run backup                                # 快照 → backups/budget-snapshot-<时间戳>.dump(+meta+README)
npm run restore -- <dump> [--force] [--allow-skew] [--url <目标库>]
npm run export-package -- <项目编号|--all> [--force]   # → backups/migration/<编号>-<日期>.json
npm run import-package -- <包文件> [--overwrite] [--owner <姓名|SSO sub>] [--allow-skew]
```

守卫:恢复遇非空库默认拒绝(`--force` 清库);导入同编号冲突默认拒绝,`--overwrite` 仅限目标项目**骨架态**(无业务记录/到账/导入批次),已有业务数据时**硬拒绝、无绕过**;导出遇 PENDING 单默认拒绝(`--force`);包/环境版本偏差默认拒绝(`--allow-skew`)。

**红线:快照备份/恢复不设任何 API/UI/MCP 入口,拒绝一切 Bearer 凭证调用——仅限管理员在服务器本机执行**(防 agent 自我备份外传凭证哈希,与凭证管理红线同款)。**例外一:迁移包「导出」开放 UI/API**(项目概览页单项目按钮 + 项目列表页批量弹窗;`project:view` 与台账导出同权,PENDING 守卫 409+确认放行;批量跨项目端点 `GET /api/export/migration-packages` 对指定项目范围凭证 403)——脱敏产物,数据面与台账导出同级。**例外二:迁移包「导入」开放 UI/API(0.38.0 起)**——项目列表页「导入项目」两阶段入口(预检 `POST /api/import/migration-package/preview` + 执行 `POST /api/import/migration-package`),口径对齐 `project:create`(仅 ADMIN;导入=建项目+落骨架),指定项目范围凭证 403,zip 逐包独立事务,UI/API 路径写审计(`action=import`);CLI 仍可用且不写审计(带外运维)。运维手册见 [docs/backup-restore.md](./docs/backup-restore.md)。

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
