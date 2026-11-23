## Agent skills

### Issue tracker

Issues 存放在本 repo 的 `.scratch/<feature>/` 目录下作为 markdown 文件。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个 canonical roles 的默认 label 字符串。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局（repo 根目录一个 `CONTEXT.md` + `docs/adr/`）。See `docs/agents/domain.md`.

## 本机即生产运行目录（动手前必读）

本仓库所在目录就是线上实例的运行目录：生产进程由 `npm run start`（即 `next start`）在此启动，运行期直接读取本目录的 `.next/`、`node_modules/`、`public/`、`CHANGELOG.md`。在这个目录里：

- **不要跑 `next build`**：会原地覆盖生产进程正在使用的 `.next/`；且本机内存很紧（可用通常 1～2.5G，swap 常常接近占满），构建峰值约 2G，一旦不足，内核的全局 OOM killer 可能选中生产进程。要验证构建，按下文在隔离副本里做。
- **不要不设 `DATABASE_URL` 就跑 `npm test`**：集成测试直连真实 PG，默认连接串指向本机 5434 上的库——正是生产库，测试会往里建用户、项目、审计日志。
- **不要在本目录随手执行 `prisma generate` / `prisma migrate deploy`**，除非目的就是部署：前者改写生产进程使用的生成客户端，后者改生产库的表结构。
- **改 `CHANGELOG.md` 和 `public/` 会立即影响线上**：`/changelog` 页在请求时直接读 `CHANGELOG.md`，`public/` 由生产进程直接对外提供。未发布条目写在 `## [Unreleased]` 下即可（解析器跳过无日期的版本节）；`src/` 下的改动要重新构建并重启才生效。
- **重活会挤占生产**：类型检查、全量测试、开发服务器各占几百 MB 到 1G 以上。放进限资源的 cgroup 里跑，超限只杀自己：
  `systemd-run --scope --collect --unit=<名字> -p MemoryMax=<上限> -p MemorySwapMax=0 -p CPUQuota=250% <命令>`，结束时 `systemctl stop <名字>.scope`。注意 Node 会按 cgroup 上限推算默认 V8 堆大小，跑 `tsc` 要显式给 `NODE_OPTIONS=--max-old-space-size=1024`（上限 1500M）。
- **不要用 `pkill`/`kill` 按命令行模式匹配杀进程**（会误伤生产进程，也会匹配到承载这条命令的 shell 自身）：按 PID 终止，并先核对 `/proc/<pid>/cwd`。用 `pgrep -f` 查找时把模式写成 `nam[e]` 的形式，并排除 `$$`，避免匹配到当前命令。
- **`codex review`（以及任何会自己执行命令的评审代理）要在隔离副本里跑，不要在本目录跑**：它会在当前目录执行 `npm run check-types` / `npm test`。只读沙箱能拦住写入（实测报 `EROFS`），但计算照跑；而且本目录里生成的 Prisma 客户端不随分支更新，`check-types` 会报出与代码无关的错误。

### 隔离验证的做法

- 源码同步到 `/tmp` 下的副本，不带 `node_modules`、`.next`、`.git`、`.env*` 和含口令的 compose override；`node_modules` 用 `cp -al` 硬链接共享。
- **工具会原地覆写的子目录必须改成真实拷贝**（删掉副本里的硬链接目录后 `cp -a`）：`.prisma`、`@prisma`、`.vite`，以及存在时的 `.cache`。漏掉任何一个都会穿透到生产目录——实测 `prisma migrate reset` 会隐式执行 `prisma generate`，Vitest 会原地写 `.vite/vitest/results.json`。
- 数据库另起一次性 Postgres 容器（`--tmpfs`、只绑 `127.0.0.1`），并显式把 `DATABASE_URL` 指过去。空库上 `tests/scripts/migration-package.test.ts` 有 7 个用例会失败（既有问题：其中一个用例删掉自己建的管理员后，指望库里还有别的管理员），先跑 `prisma/seed.ts` 再测。
- 生产构建放不进 1700M 的安全上限：内置的类型检查、以及页面数据收集（默认 4 个工作进程）都会超出。只在副本的 `next.config.ts` 里加 `typescript: { ignoreBuildErrors: true }` 和 `experimental: { cpus: 1 }`，即可在上限内完成编译、路由收集与静态生成；类型检查用 `tsc --noEmit` 单独验证。这两项不要写回仓库。
- 生产构建只能以 SSO 模式运行（启动守卫禁止非 development 环境开 `MOCK_AUTH`）；需要登录态时，用沙箱自己的 `AUTH_SECRET` 签 `bm_session` cookie。
- 做完用 `find node_modules .next -newermt '<开始时间>'` 确认生产目录零改动，再删除副本与容器。
- 测试里给 Prisma 委托做故障注入不要用 `vi.spyOn(...).mockRestore()`（本仓库的 Vitest 1.6 会把方法留成 `undefined`，污染同进程后续用例）：手工替换方法再赋回。
- 用项目依赖里的 `playwright` 包写脚本时，它要求的 chromium 版本可能与已安装的不一致：用 `chromium.launch({ executablePath })` 指向 `~/.cache/ms-playwright/chromium_headless_shell-*/` 下已有的可执行文件即可，不必下载。带动画的界面（如移动端抽屉）要等动画结束再量尺寸、截图。

## Browser automation

playwright-cli 浏览器自动化使用 chromium：本机未安装 Chrome 发行版（`/opt/google/chrome/chrome` 不存在，安装需 sudo),`playwright-cli open` 必须带 `--browser=chromium`(Playwright 自带 chromium 已装在 `~/.cache/ms-playwright/`)。截图等临时产物已被 `.gitignore`(`*.png`、`.playwright-cli/`)。
