# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。
版本发布流程见 [AGENTS.md](./AGENTS.md)。

## [0.3.0] - 2026-08-06

### 新增

- **Authentik SSO 登录**:登录页 + OIDC 授权码流程(PKCE/state/nonce),`openid-client` + `jose` 手写集成,会话为 HttpOnly JWT cookie(8h)
- 首次 SSO 登录自动建档(JIT,默认普通用户);`npm run make-admin -- <用户名>` 提升首个管理员
- 项目成员管理:管理员在项目概览页增删成员、调整角色(负责人=全部权限 / 成员=可录入),全程审计留痕
- 新建项目可指定负责人(自动获得 OWNER 成员编辑权)
- 顶栏用户菜单(姓名 + 角色 + 退出登录,联动 Authentik end-session)
- **统一业务录入页**(`/records`,侧边栏「业务录入」):跨项目录入卡片(项目 → 叶科目级联,连续录入)+ 全局记录列表(默认可录入项目,可切全部只读),行内修改/作废
- 新增 `GET /api/me/projects`:全部项目 + 当前用户权限标记(统一页数据源)
- 成员管理与级联选择改可搜索 Combobox(新增 cmdk Command/Combobox 组件)
- **业务记录 Excel 式表头筛选**(两页):每列表头漏斗(值清单勾选 / 文本包含 / 金额范围 / 日期范围);日期筛选含快捷预设(今天/最近7天/本月/本季度/本年等)+ 起止日期输入框 + 日历拖选

### 变更

- **角色模型收敛(破坏性)**:全局角色改为 `ADMIN` / `USER` 两级;项目编辑权改由 `ProjectMember(OWNER)` 驱动——存量 `PROJECT_OWNER` / `AUTHORIZED_HANDLER` 用户迁移为 `USER`,并按 `Project.ownerId` 自动回填 OWNER 成员行
- **HANDLER 成员可录入**:`record:create/edit/void` 对 OWNER+HANDLER 放行(录入人员=HANDLER);预算编制/调整/导入仍 OWNER 专属;项目详情随下发 `canEdit` + `canWriteRecords`
- **普通用户全局只读**:全部项目的台账/记录/统计/审计日志可见,编辑动作服务端 403
- 查看态 UI 门控:无编辑权时隐藏/禁用新建项目、新增记录、发起调整、保存、导入等入口
- `MOCK_AUTH` 开关保留:本地开发/测试继续用 mock 身份;`false` 时启用 SSO 并强制要求 OIDC 环境变量
- `/api/users` 在 SSO 模式下仅管理员可用(`user:list`);`excel-template` 下载补充登录校验

### 修复

- 审批待办接口由原始角色比较改为权限矩阵校验
- 调整草稿编辑/删除补齐项目级权限校验(此前只查全局角色)
- 业务记录页筛选与变更刷新共用同一查询(修掉筛选变化后列表卡加载态)
- 日历月份切换箭头被网格覆盖(加 z-10)
- cookie Secure 标记按 APP_BASE_URL 协议推导(修 http 生产部署登录断链)

## [0.2.0] - 2026-08-05

### 新增

- 侧边栏支持收缩为图标窄栏（cookie 持久化，首屏无闪烁），底部展示版本号
- 新增「更新日志」页面（`/changelog`）与侧边栏入口，渲染本文件
- 初始预算编制：无草稿时默认套用 18 项预设科目模板 + 当年年度行，附「清空科目」出口
- 执行台账叶科目可点击，跳转业务记录页并自动筛选（`subjectId` + `year`）
- 业务记录支持连续录入（保存并继续新增）
- 亮 / 暗双主题切换（next-themes）

### 变更

- **全量 UX 重构**：antd 完全移除，迁移至 shadcn/ui + Tailwind CSS 4（DESIGN.md / Vercel 设计语言 token 体系）
- 项目详情页改为 Tab 子导航，侧边栏精简；「年初预算」更名「初始预算编制」
- 树形台账表用 TanStack Table 重写，支持列显隐
- 预算编辑器改为显式保存 + 脏状态追踪，离开拦截覆盖浏览器关闭/刷新与站内导航
- 预算调整原因改用原生受控 textarea，根治中文输入法被打断
- 统计分析改为网格查询构建器，科目随项目即时加载

### 修复

- 脏状态下 SPA 站内导航（项目 Tab / 侧边栏）绕过离开拦截导致草稿丢失（PR #1 codex review）

## [0.1.0] - 2026-07-29

### 新增

- 初始版本：项目管理、预算编制与审批、双维度预算调整、业务记录、执行台账、到账流水、Excel 导入、年度结转、统计分析、操作日志（antd 5 界面）
