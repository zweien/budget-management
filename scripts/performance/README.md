# 独立性能基准

仅操作本机专用库与专用端口。合成数据没有真实财务信息；夹具脚本不回落到应用连接、不清空已有数据库。

1. 创建空的 `budget_perf_<本次运行标识>` 数据库，并用当前 Prisma migrations 执行 `migrate deploy`。测试另用独立空库，不与性能数据混跑。
2. 设置 `PERF_DATABASE_URL` 为上述专用库、`PERF_AUTH_SECRET` 为本次独立服务的随机签名密钥（至少32字符）。这些值保留在本机环境，不提交版本库。
3. 运行 `npm run perf:seed`，默认 10 项目 × 每项目 1 万记录、10 用户、一般/包干两种预算、三年度、四种状态和作废记录；3 个不可压缩的 8 MiB 附件用于区分元数据与二进制读取。可设置 `PERF_PROJECTS` / `PERF_ROWS`；ID 清单默认写 `.scratch/performance/fixture.json`。
4. 在需要测量的代码版本建立独立工作区，执行 `npm ci`、`prisma generate` 与文件预览资产复制脚本。使用 `node scripts/performance/app.mjs build <独立工作区>` 构建，再用同一命令的 `start` 模式启动。默认端口 3110，可设 `PERF_PORT`。
5. 从当前工作区运行 `npm run perf:measure`。`PERF_BASE_URL` 默认 `http://127.0.0.1:3110`，只允许本机 3100 以上专用端口。预检会确认服务项目集合与夹具一致。使用正常签名会话读取合成用户，服务仍实时查库授权；不依赖真实 OIDC 登录，也不禁用启动守卫。

浏览器依赖来自 devDependency `playwright`。使用其 Chromium，或通过 `PERF_CHROMIUM_PATH` 指定已有的兼容可执行文件。原始数据路径 `PERF_OUTPUT` 默认 `.scratch/performance/baseline.json`；`PERF_LABEL` 标注版本；`PERF_SAMPLES` 默认 20、`PERF_BROWSER_SAMPLES` 默认 5（设为 0 跳过浏览器）。

API 测量包含读取并消费响应体的端到端耗时，预热请求不计入样本；浏览器使用独立会话/空浏览器缓存，服务器保持预热。页面可用终点是主要内容出现、主体加载占位消失并经过两帧绘制；单独记录 DOM、长任务、资源字节和请求次数。不得用少量浏览器样本的 p95 声称正式验收通过。

`project-records-legacy` 保留对旧全量 API 的对照，区别于改造后页面的分页通路。响应 SHA256 便于发现只读数据差异，但稳定排序的预期变化需比较记录集合/金额语义，不能只看哈希。此脚本当前覆盖正常只读基线；10 名用户混合交互、保存、导入/导出/附件干扰与弱网络需分别补充，不把 10 个并发 GET 当作 10 名活跃用户。

应用返回 `X-Request-Id` 与 `Server-Timing` 后，可以将浏览器请求与结构化日志关联。`dbOperations` 是 Prisma 操作数而非底层 SQL 条数；`dbDurationMs` 含池等待，且并行操作耗时会重叠，不能从请求总耗时简单减去它，也不能宣称已经单独测出连接等待或纯 SQL 执行时间。真实慢查询再结合 PostgreSQL 执行计划定位。

交互回归：`PERF_ALLOW_WRITES=1 npm run perf:regression`。在专用合成库检查延迟查询时的批量操作保护、延迟写入后翻页、连续输入的请求数、URL刷新恢复、导出全集、清除状态时包含作废与保存后候选更新。`PERF_REGRESSION_ONLY` 可选单个用例；其中候选用例会修改合成经办人，状态竞态用例只拦截网络完成顺序。

混合负载：`PERF_ALLOW_WRITES=1 npm run perf:workload`。10个独立签名用户各操作自己的合成项目，每项导航20样本、筛选60样本、保存确认20样本；保存从点击按钮计到服务端确认、列表重拉与结果出现。常规和重任务两个阶段分别记录；重任务通路依次执行2000行导入确认、年度记录导出、24MiB附件打包，并记录每次普通交互是否与重任务时间区间重叠。这里的串行重任务是测量条件；应用的大文件另有进程内并发预算：超过5000行的Excel、超过8MiB的附件打包共用一个名额，最多等待8个、30秒，出队重新验证身份。小文件直接执行；该队列随进程结束，不持久化文件任务。

- `PERF_PHASES=mixed` 可仅运行混合阶段；`PERF_LARGE_EXPORT=1` 改为前5个合成项目的五万条级导出，具体行数随前次合成写入增加，结果中 `rowsAtStart` 记录实际总行数。
- `PERF_APP_PID` 为本次专用服务器进程PID时，每100ms从 `/proc` 采集RSS；该值含V8保留堆、原生库和缓冲区，不等同于活跃对象大小，进程历史影响高水位。
- 所有写入都是合成数据；重复运行会增加导入记录、审计和批次，并修改合成摘要。严格可比的前后对照应从同一夹具快照启动，或清楚记录差异；不要将固定规模标签误作当前精确行数。
- `PERF_ONLY=project-records PERF_FAULT_PATH=/api/statistics/custom` 配合 `perf:measure` 可注入503，校验错误UI不会被算成成功样本；期望退出1、样本数0，并保留错误结果。

当前驱动优先覆盖内网同机桌面场景。真实部署硬件/网络、较长稳态、弱网络与更极端附件组合需单独复测，不能由这些短时结果外推。

分类型同步干扰：`PERF_ALLOW_WRITES=1 npm run perf:interference`。每类重任务分别与页面切换、筛选、新增保存、修改保存同时触发，10用户×2轮，每项20样本，按实际重叠样本校验，不能把导入开场的重叠外推给后面的保存。`PERF_KINDS=idle,parse,import,export,zip` 选择类别，`PERF_EXPORT_CONCURRENCY=2` 测两个同时申请的大导出（由应用排队）。所有实际输入事件在浏览器内打点，终点包含列表刷新和绘制；同时保留含自动化 actionability 等待的 `driverMs`，便于识别驱动等待。缺少样本/交互失败退出1，p95超目标退出2；正常全页导航目标2秒，交互目标1秒。
