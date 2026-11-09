# 备份与迁移:pg_dump 快照备份 + JSON 迁移包,仅限管理员本机 CLI

系统需要备份与跨环境迁移能力,但两类需求职责不同:**同环境灾难恢复**要求 100% 保真(用户、机器凭证哈希、台账、审计全在内,天然敏感),**跨环境迁移**只要项目+预算骨架且必须脱敏可分享。全部数据(含附件 bytea)在单一 PostgreSQL,本地经 docker compose 运行、生产为内网独立 pg 主机;本仓库 agent 生态发达(API/MCP/skill 均可写操作)。我们决定分两档产物:**快照备份/恢复只经管理员服务器本机 CLI 产生与消费,不开任何 API/UI/MCP 入口;迁移包「导出」自 0.37.0 起开放 UI/API**(单项目 `GET /api/projects/:id/export/migration-package`、批量 `GET /api/export/migration-packages`,project:view 与台账导出同权,批量跨项目端点对指定项目范围凭证 403);**迁移包「导入」自 0.38.0 起亦开放 UI/API**——预检+执行两端点(`POST /api/import/migration-package/preview|:root`),口径对齐 `project:create`(仅 ADMIN,导入=建项目+落预算骨架),指定项目范围凭证 403,zip 逐包独立事务(≤500 包),UI/API 路径写审计(`action=import`,与业务同事务;CLI 不传 actor 维持带外不写)。快照红线的动机是防凭证哈希外传,对脱敏的迁移包不成立;导入收窄到 ADMIN 是因为它与「建项目」同权,而非沿用导出的只读口径。

1. **快照备份**:pg_dump `-Fc` 全库导出,执行载体自动探测(`docker compose exec` → `docker run postgres:16-alpine` → 本机 pg_dump;compose 载体仅当 DATABASE_URL 的 host:port 与 compose 发布端口一致时启用,防「URL 指外部库而本机 compose 在跑」时静默 dump 错库)。恢复默认拒绝非空目标库(全表口径计数,`_prisma_migrations` 不算数据),`--force` 先打印将丢弃的行数概要再清库,`pg_restore --clean --if-exists` 兼容零数据但建过 schema 的目标;导出时刻的 appVersion + Prisma 迁移头与目标不一致默认拒绝,`--allow-skew` 放行。.env 不进包,包内附恢复说明 README;产物 chmod 600,存 `backups/` 根;迁移包为可分享产物,分目录存 `backups/migration/`。
2. **迁移包**:单项目 JSON envelope(formatVersion / appVersion / exportedAt / migrationHead / 数据体 / 来源附注),内容 = 项目信息、科目树、汇总与科目×年度预算行、初始编制单、调整单(+明细)、科目变更单;**不含**成员、业务记录、到账、附件、审计、凭证。保留原 ID,以项目编号为幂等键。User 引用按可空性分流(必填列无法置空):同 ID 用户在目标环境存在 → 保留;必填引用(`Project.ownerId` 与各申请单 `applicantId`)→ 重映射到**导入操作者**(`--owner` 指定用户;缺省取目标环境最早创建的 ADMIN 占位并醒目警告、不建成员关系);可空引用(`approverId`)→ 置空;原操作人 id 与名字快照一律记入包内「来源附注」。导入支持合并进非空库:同编号冲突默认拒绝;`--overwrite` **仅当目标项目为骨架态**(无业务记录、无到账、无导入批次)时可用,否则硬拒绝且无任何 flag 可绕过——包不带台账,就没有资格销毁目标侧台账。导出侧:PENDING 状态的编制/调整/科目变更单存在时默认拒绝,`--force` 才带出,导入按原状态还原;导入后自动从科目行重算汇总并打印差异报告,可加 `--owner` 直接认领。

## Considered Options

- **统一叫「备份」分完整/部分两力度**:同一词承载「敏感不外传」与「可分享脱敏」两种相反的保密属性,迟早有人把含凭证哈希的完整备份当迁移包发出去——故词汇表分立「快照备份 / 迁移包」两词条(CONTEXT.md「备份与迁移」节)。
- **应用层全量导出(Prisma 遍历写 JSON)**:无外部依赖,但 21 张表+序列+约束的保真全靠自己维护,易漂移;完整档交给数据库原生工具,应用层导出仅保留在迁移包这一档(白名单表集合,可控)。
- **迁移包复用预算导出表(xlsx)版式**:人眼友好但回导解析脆;xlsx 保留「人读快照/线下填报」职责,机读回导走 JSON,两者并存。
- **覆盖时级联删除目标项目数据(双 flag 确认)**:台账是核心资产,包只带骨架就没有授权销毁目标台账的资格;真要毁数据走数据库层人工操作,不给脚本捷径。
- **开 API/UI 备份入口**:方便,但快照含凭证哈希与全部审计,任何网络面(含浏览器下载临时文件)都是泄漏点;与「凭证管理拒绝 Bearer」同款红线——**快照备份/恢复**仅限管理员本机 CLI,agent 一律不可调用。(0.37.0 修订:为**迁移包导出**开 UI/API 例外——脱敏产物、与台账导出数据面同级;0.38.0 再为**导入**开 ADMIN-only 例外——对齐 `project:create` 而非导出的只读口径,写审计;快照/恢复例外永不开放。)

## Consequences

- 备份机需有 docker 或 pg 客户端之一;离线部署包本基于 docker,内网可行,本机无 pg_dump 不构成阻塞。
- 迁移包 formatVersion 一旦流通即成兼容契约,后续 schema 变更需同步演进包格式并兼容旧包(版本守卫拦住错位导入,但不代替格式演进)。
- CLI 导入/恢复属带外运维操作,不写 AuditLog(与 make-admin / make-agent / export-project-budget.ts 一致);导入后项目默认无 OWNER,由目标环境管理员经 `--owner` 或 UI 认领。
- 科目映射记忆(由未作废业务记录推导)不随包迁移,目标环境录入若干条后自然重建——可接受的数据边界。
- 导入为单事务全或无;schema 不对称(InitialBudgetApplication.applicant 有 FK 而 BudgetAdjustment.applicantId 是裸列)由上述重映射规则统一抹平;项目负责人字段(ownerId)是展示元数据,占位 ADMIN 不代表成员关系,认领以 ProjectMember 为准。
- 导入后的汇总校验独立成事务:一般项目按科目层 Σ 重算 project/annual 两层(漂移>0.01 自动修复);包干制项目无科目总预算层,只做年度层校验且不盲改项目层。校验口径由 `summaryRecalc.service` 统一承载(迁移导入与 recalc-summary-budgets 的 `--from-subjects` 模式共用;引擎按预算类型分流,顺带修正了旧脚本对包干制项目层清零的问题)。
- `--overwrite` 替换的边界透明化:目标侧成员移除数、审计行解绑、审批日志引用悬空都写入导入报告 warnings。
