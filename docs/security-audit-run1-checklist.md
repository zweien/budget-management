# 安全审计修复 checklist(run-1 未纳入项与部署侧动作)

> 依据 2026-09-28 的 security-audit 全量审计(`~/security-audit-skill/budget-management/run-1/`,
> 1 confirmed + 20 needs_validation)。本批代码修复(分支 `fix/security-audit-run1`,v0.17.1)
> 覆盖 P0 快速包 + 状态机竞态 + 两项行为收紧;**以下事项未纳入该批,按优先级列出**,
> 逐项给出验证/修复路径。审计完整记录见同目录 findings.json / NEEDS-VALIDATION.md。

## 1. 资源上限族(P2,建议下批处理)

全部共享同一爆炸半径:单 Node 进程 + Prisma 池默认 10 连接;任意已认证主体(含只读档
无人值守 key)可反复触发。以下按审计指纹列出:

- [ ] **JSON 请求体无上限**(bm1-plat-json-body-nocap)
      28 处 `req.json()` 在鉴权后、授权前全量缓冲;pinned Next 16.2.12 对 route handler 无 body 上限。
      方案:withRoute 层提供 `readJson(req, cap)`(流式计数上限,默认 1MB,env 可调),机械替换 28 处;
      Content-Length 预检兜底。
- [ ] **附件上传先缓冲后校验**(bm1-att-upload-body-buffer-unbounded)
      `req.formData()` + `arrayBuffer()` 先于 50MB 检查与 `record:edit` 鉴权。
      方案:路由开头 Content-Length 预检(> 上限即 413);流式 multipart 需框架支持,列观察项。
- [ ] **zip 导出按条数不按字节**(bm1-att-zip-export-byte-unbounded)
      500 个 × 50MB = 25GB 仍放行,STORE 全量内存物化(峰值 ~2×)。
      方案:导出前 `aggregate({_count, _sum: {sizeBytes}})` 加字节门(建议 512MB,env 可调,413);
      载入后复查 rows.length;中期改流式生成。
- [ ] **xlsx 解压放大且先解析后鉴权**(bm1-imp:xlsx-decompress-preauthz-parse)
      10MB 压缩上限后 exceljs 全量解压无预算;标准模板双倍解析;requirePermission 在解析之后。
      方案(快):路由层先把 `requirePermission(user,'record:import',id)` 提到解析之前;
      `loadSettlementWorkbookIfMatch` 返回 workbook 传入 parse(消除双解析);
      解压预算需流式解析器(exceljs 不支持),列升级观察项。
- [ ] **records/receipts/ledger/ledger-total/export-ledger 无分页全量物化**(bm1-rec-unbounded-project-list-materialization)
      方案:加可选 page/pageSize(缺省全量,兼容现 UI);ledger 聚合下推 SQL(statistics 已有先例)。
- [ ] **statistics custom 导出全量 xlsx**(bm1-sxp-statexport-unpaged-full-record-xlsx)
      方案:exportStatistics 前置 count 门(如 10 万行 → 413 提示加筛选);或透传 page/pageSize 分块。
- [ ] **subject-mappings 聚合无 DB 级上限**(bm1-smap-groupby-unbounded-aggregation)
      方案(快):q 非空时 pushdown `summary: { contains, mode: 'insensitive' }`;
      中期:record create/void 时维护 per-project 摘要计数 rollup,接口改 O(limit)。

## 2. SSO 传输安全(P3,需部署决策)

- [ ] **http 部署双降级**(bm1-auth-http-deploy-insecure-sso)
      现网 `.env`(192.168.5.6)issuer 与 base URL 均为 http:allowInsecureRequests 生效 +
      bm_session 无 Secure;且 pinned oauth4webapi 默认 code flow **不验 ID token 签名**,
      明文链路上 MITM 可伪造 id_token 任选 sub 建档。
      决策二选一:
      a. 内网段迁移 https(Authentik 与 APP_BASE_URL 均改),env.ts 加 scheme 校验;
      b. 明确豁免:env 加 `ALLOW_INSECURE_SSO=1` 显式声明 + 记录受信网段范围,并在 env.ts 校验
      「非豁免则必须 https」。
      无论哪种:openid-client 启用 `enableNonRepudiationChecks` 作纵深。

## 3. 部署侧动作(运维,不属代码)

- [ ] **轮换数据库凭据**:compose 中 budget/budget 已随仓库公开;端口已改绑 127.0.0.1,
      但历史连接面未知——改口令 + `.env` 同步。
- [ ] **生产 env 巡检**:确认所有实例 `MOCK_AUTH=false`(v0.17.1 起非 development 一律拒绝
      mock 启动)、`NODE_ENV=production`、`AUTH_SECRET` 强熵(≥32 随机字符)。
- [ ] **ingress 巡检**:是否有反向代理/CDN 缓存 `/api/*`(审计 bm1-cache-export-no-store
      的跨主体复用前提;代码已补 no-store,代理侧再确认不缓存 API 路径)。
- [ ] **防火墙确认**:`ss -tlnp | grep 5434` 确认只绑 127.0.0.1;历史开放的窗口期评估。
- [ ] **GitHub Actions 默认 token**:Settings → Actions → Workflow permissions 应为
      「Read repository contents and packages permissions」(代码已加 `permissions: contents: read`,
      此为组织级兜底)。
- [ ] **Authentik 显示名策略**:确认普通用户能否自改 name/preferred_username、是否允许重复
      显示名;CLI 已做歧义拒绝,IdP 侧收紧可除根。
- [ ] **`.next/standalone/.env` 泄露**:`next build` 会把 `.env` 原样复制进 standalone 产物
      (实测含真实密钥)。非 Docker 分发 standalone 前必须剥离;可加 postbuild 清理脚本。
- [ ] **审计拒绝写入可观测性**:`permissions.ts` 的 `auditMachineDenied` 尾部
      `.catch(() => {})` 静默丢弃失败——至少 console.error 一行,保证审计缺口可被发现。

## 4. 运行时验证(源码已定论,待本地/线上观察)

以下审计结论源码链完整,按 NEEDS-VALIDATION.md 的计划执行本地验证即可定论/关闭:

- [ ] bm1-stat-custom-projectids-scope-bypass —— **已修复**(白名单交集);
      回归测试已入 `tests/server/statistics.service.test.ts`。线上抽查一次混参请求确认 403。
- [ ] bm1-bud-initialbudget-state-race —— **已修复**(FOR UPDATE + 条件迁移);
      交错回归已入 `tests/server/initialBudget.approve.test.ts`。真实双会话竞态可按审计计划补验。
- [ ] bm1-mcp-confirm-import-missing-selectedrowids —— **已修复**(工具补 selectedRowIds);
      本地 stdio 调用一次确认 200。
- [ ] bm1-mcp-write-intent-unbound —— 未纳入(设计决策):「指令授权」层的确定性绑定方案
      三选一:(a) 写工具增加 `confirmToken`(任务指令派生)服务端校验;(b) 服务端给无人值守
      write key 增加「单批次确认上限」;(c) 维持现状(靠 skill 约定 + 审计追踪),在 AGENTS.md
      明示剩余风险。建议与业务方讨论后单独立项。
- [ ] bm1-web-logout-get-csrf —— **已修复**(Sec-Fetch-Site 校验);旧浏览器(不带该头)
      场景如需覆盖再评估改 POST。
- [ ] 其余 bm1-att-* / bm1-imp:xlsx / bm1-plat-json-body / bm1-smap / bm1-sxp /
      bm1-rec-unbounded / bm1-sup-ci / bm1-sup-compose / bm1-adm-cli-name —— 已修代码侧部分 +
      本清单 1/3 节对应项;运行时阈值验证(内存增长曲线等)按审计 validation_plan 在本地沙箱执行。

## 5. 其他加固(审计 hardening 摘选,未纳入)

- [ ] 会话 JWT 显式 `algorithms: ['HS256']` + iss/aud 绑定;jti 黑名单或更短 TTL 评估。
- [ ] voided 记录禁止编辑(409);金额校验 `toFixed(2) > 0` 与上界;receipt 日期日历往返校验;
      void 幂等条件更新。
- [ ] 死代码清理:`scripts/gen_adjustment_docx.py` + `requirements.txt` + `getAccessibleProjectIds`
      (零调用点);`next.config.ts` 的 `.venv` 追踪排除随之移除。
- [ ] 运维脚本(`recalc-summary-budgets --apply`、`backfill_sort_order`)补 recordAudit 与
      dry-run 默认、排除归档项目。
- [ ] 完整 CSP 策略(当前仅基线头)。
