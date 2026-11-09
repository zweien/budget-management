# 备份与恢复运维手册(ADR 0003)

两档产物,职责与保密属性相反:

|      | 快照备份                                                                                | 迁移包                                                  |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 用途 | 同环境灾难恢复                                                                          | 跨环境导入重建项目                                      |
| 内容 | pg_dump 全库(用户、凭证哈希、台账、审计全在内)                                          | 单项目:项目信息、科目树、四层预算、编制/调整/科目变更单 |
| 保密 | **敏感,不可外传**                                                                       | 脱敏,可分享(不含用户/成员/业务记录/到账/附件/审计)      |
| 格式 | `budget-snapshot-<时间戳>.dump`(pg_dump custom,chmod 600)+ `.meta.json` + `.README.txt` | `migration-<项目编号>-<日期>.json`                      |

## 快照备份

```bash
npm run backup                 # → backups/ 三件套
npm run backup -- --out /mnt/nas/backups
npm run backup -- --url postgresql://…   # 显式指定目标库(外部 PG)
```

- 执行载体自动探测:`docker compose exec postgres`(仅当 DATABASE_URL 的 host:port 与 compose 发布端口一致,防静默备份错库)→ `docker run --rm --network host postgres:16-alpine`(直连 DATABASE_URL)→ 本机 pg_dump。
- `.env` 不入包:恢复目标需自行准备环境变量(`AUTH_SECRET`、Authentik 三件套、`DATABASE_URL`、`APP_BASE_URL`)。

### 定时备份(cron 示例,本系统不内置调度)

```cron
# 每天凌晨 2:30 快照,保留最近 14 天(三件套按前缀一并清理)
30 2 * * * cd /path/to/budget-management && npm run backup >> backups/cron.log 2>&1 && find backups/ -maxdepth 1 -name 'budget-snapshot-*' -mtime +13 -delete
```

## 快照恢复

```bash
npm run restore -- backups/budget-snapshot-20261108-023000.dump [--url <目标DATABASE_URL>]
```

守卫与逃生门:

1. **版本守卫**:dump 同名 `.meta.json` 的 `appVersion`/`migrationHead` 与当前环境不一致 → 拒绝。确认自担风险加 `--allow-skew`。
2. **非空守卫**:目标库任何业务表有数据(全表口径,`_prisma_migrations` 不算)→ 拒绝并列出计数。确认整体丢弃加 `--force`:先打印将丢弃的行数概要,再 `DROP SCHEMA public CASCADE` 重建,`pg_restore --clean --if-exists`(兼容「零数据但建过 schema」的库)。
3. 恢复后建议 `npm run dev` 冒烟:项目列表、台账、SSO 登录。

**演练建议**:不定期在临时库演练恢复(测试 `snapshot-roundtrip` 即为此设计;手动演练如下):

```bash
npm run backup
docker compose exec postgres psql -U budget -d budget -c 'CREATE DATABASE budget_restore_drill'
npm run restore -- backups/<最新dump> --url postgresql://budget:budget@localhost:5434/budget_restore_drill
# 抽查行数一致后清理:
docker compose exec postgres psql -U budget -d budget -c 'DROP DATABASE budget_restore_drill WITH (FORCE)'
```

## 跨环境迁移项目

导出有两类入口,产物同构:

- **CLI**:服务器本机执行,适合脚本化/全量;
- **UI**(0.37.0 起):项目概览页「导出迁移包」按钮(单项目);项目列表页「导出迁移包」弹窗(批量勾选,默认全选当前筛选结果,产出 zip:每项目一个 `migration-<编号>.json` + `manifest.json` 成功/跳过/失败清单)。存在待审批单时先弹确认(等价 CLI `--force`);权限与台账导出同权(`project:view`)。

源环境(CLI):

```bash
npm run export-package -- 617        # 按编号(或名称关键字)→ backups/migration/migration-617-<日期>.json
npm run export-package -- --all      # 全部项目 → backups/migration/<日期>/ 目录
```

迁移包可分享、快照敏感,产物分目录存放(`backups/migration/` vs `backups/` 根)。

- 项目存在 PENDING(待审批)单时默认拒绝;确认带出加 `--force`,目标环境管理员可继续审批。

目标环境(**UI 入口**,0.38.0 起,仅 ADMIN):项目列表页「导入项目」→ 上传 .json 单包或 .zip 批量 → 只读预检(版本偏差/同编号冲突/骨架态/包内待审批单逐项标注)→ 勾选确认(负责人认领下拉、`--allow-skew`/`--overwrite` 对应勾选)→ 执行(逐包独立事务,执行端全量重跑守卫);UI/API 导入写审计(`action=import`)。

目标环境(CLI,仍可用):

```bash
npm run import-package -- backups/migration-617-20261108.json --owner 张三
```

语义与守卫:

- **幂等键 = 项目编号**:同编号已存在时默认拒绝;`--overwrite` 整体替换,但**仅限骨架态目标项目**(无业务记录/到账/导入批次)——已有业务数据时硬拒绝且无任何绕过通道(迁移包不带台账,无权销毁目标侧台账)。
- **版本守卫**:包的 `appVersion`/`migrationHead` 与目标环境不一致默认拒绝,`--allow-skew` 放行。
- **User 引用**:必填引用(负责人、申请人)重映射到 `--owner` 用户;未指定 `--owner` 时以目标环境最早的 ADMIN 占位负责人(警告提示,不建成员关系),之后在 UI「成员管理」认领;可空引用(审批人)置空。原操作人名字快照保留在包内 `provenance` 节。
- **导入为单事务全或无**;导入后自动按科目层校验汇总行,一般项目漂移>0.01 自动修复,包干制仅报告不盲改项目层。
- 科目映射记忆(由业务记录推导)不随包迁移;目标环境录入若干条后自然重建。

## 红线

**快照备份 / 恢复仅限管理员在服务器本机 CLI 执行**:不设 API/UI/MCP 入口,拒绝一切 Bearer 凭证调用——防止 coding agent 自我备份外传凭证哈希(与「凭证管理拒绝 Bearer」同款红线,见 AGENTS.md)。例外:迁移包**导出**开放 UI/API(脱敏产物,数据面与台账导出同级;批量跨项目端点对指定项目范围凭证 403);迁移包**导入**开放 UI/API(0.38.0 起,仅 ADMIN、对齐 `project:create`,写审计;CLI 仍可用)。
