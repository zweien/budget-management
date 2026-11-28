## Agent skills

### Issue tracker

Issues 存放在本 repo 的 `.scratch/<feature>/` 目录下作为 markdown 文件。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个 canonical roles 的默认 label 字符串。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局（repo 根目录一个 `CONTEXT.md` + `docs/adr/`）。See `docs/agents/domain.md`.

## 本机即生产运行目录（动手前必读）

本仓库所在目录就是线上实例的运行目录：生产进程由 systemd 单元 `budget.service` 管理（`systemctl restart budget`，日志看 `journalctl -u budget`），以专用非特权用户 `budget` 运行，**2026-11-28 起不再由 PM2 管理**（`pm2` 里只剩同机的其他应用；应急切回见 `/root/budget-ops/rollback-to-pm2.sh`）。运行期直接读取本目录的 `.next/`、`node_modules/`、`public/`、`CHANGELOG.md`。在这个目录里：

- **不要跑 `next build`**：会原地覆盖生产进程正在使用的 `.next/`；且本机内存很紧（可用通常 1～2.5G，swap 常常接近占满），构建峰值约 2G，一旦不足，内核的全局 OOM killer 可能选中生产进程。要验证构建，按下文在隔离副本里做。
- **不要对着生产库跑 `npm test`**：集成测试会往库里建用户、项目、凭证、审计日志。本目录存在 `.env.production`，`vitest.config.ts` 据此直接拒绝启动测试，除非显式把 `DATABASE_URL` 指向别的库（守卫与原因见 `tests/helpers/testDbGuard.ts`）——历史上测试曾在本目录直接跑过 19 轮，在生产库留下 76 个夹具账号。
- **不要在本目录随手执行 `prisma generate` / `prisma migrate deploy`**，除非目的就是部署：前者改写生产进程使用的生成客户端，后者改生产库的表结构。
- **发版 = 在隔离副本里构建，再原子替换**：`systemctl stop budget` → 用 `mv` 换入新的 `.next/` 与 `node_modules/`（旧目录移到 `/opt/budget-release-previous/`，**不要留在本目录**——`tsc`/`eslint`/rsync 会把它们当成源码扫进去）→ `chown -R budget:budget .next/cache` → `systemctl start budget` → `curl 127.0.0.1:3000/api/health`。应用对程序目录只读（单元里 `ProtectSystem=strict`），只有 `.next/cache` 可写。
- **备份是自动的**：`budget-backup.timer` 每天北京时间 02:30 做快照（保留 14 天，日志 `journalctl -u budget-backup`），产物在 `backups/`。快照默认只在本机；异地同步要在 `/etc/budget-management/offsite.env` 填 `OFFSITE_DEST` 才生效。运维手册：`/usr/local/lib/budget-ops/README.md`。
- **改 `CHANGELOG.md` 和 `public/` 会立即影响线上**：`/changelog` 页在请求时直接读 `CHANGELOG.md`，`public/` 由生产进程直接对外提供。未发布条目写在 `## [Unreleased]` 下即可（解析器跳过无日期的版本节）；`src/` 下的改动要重新构建并重启才生效。
- **重活会挤占生产**：类型检查、全量测试、开发服务器各占几百 MB 到 1G 以上。放进限资源的 cgroup 里跑，超限只杀自己：
  `systemd-run --scope --collect --unit=<名字> -p MemoryMax=<上限> -p MemorySwapMax=0 -p CPUQuota=250% <命令>`，结束时 `systemctl stop <名字>.scope`。注意 Node 会按 cgroup 上限推算默认 V8 堆大小，跑 `tsc` 要显式给 `NODE_OPTIONS=--max-old-space-size=1024`（上限 1500M）。
- **不要用 `pkill`/`kill` 按命令行模式匹配杀进程**（会误伤生产进程，也会匹配到承载这条命令的 shell 自身）：按 PID 终止，并先核对 `/proc/<pid>/cwd`。用 `pgrep -f` 查找时把模式写成 `nam[e]` 的形式，并排除 `$$`，避免匹配到当前命令。
- **`codex review`（以及任何会自己执行命令的评审代理）要在隔离副本里跑，不要在本目录跑**：它会在当前目录执行 `npm run check-types` / `npm test`。只读沙箱能拦住写入（实测报 `EROFS`），但计算照跑；而且本目录里生成的 Prisma 客户端不随分支更新，`check-types` 会报出与代码无关的错误。

### 隔离验证的做法

- 源码同步到 `/tmp` 下的副本，不带 `node_modules`、`.next`、`.git`、`.env*` 和含口令的 compose override；`node_modules` 用 `cp -al` 硬链接共享。
- **工具会原地覆写的子目录必须改成真实拷贝**（删掉副本里的硬链接目录后 `cp -a`）：`.prisma`、`@prisma`、`.vite`，以及存在时的 `.cache`。漏掉任何一个都会穿透到生产目录——实测 `prisma migrate reset` 会隐式执行 `prisma generate`，Vitest 会原地写 `.vite/vitest/results.json`。
- 数据库另起一次性 Postgres 容器（`--tmpfs`、只绑 `127.0.0.1`），并显式把 `DATABASE_URL` 指过去。空库上 `tests/scripts/migration-package.test.ts` 有 7 个用例会失败（既有问题：其中一个用例删掉自己建的管理员后，指望库里还有别的管理员），先跑 `prisma/seed.ts` 再测。
- 生产构建放不进 1700M 的安全上限：内置的类型检查、以及页面数据收集（默认 4 个工作进程）都会超出。只在副本的 `next.config.ts` 里加 `typescript: { ignoreBuildErrors: true }`，并用环境变量 `CIRCLE_NODE_TOTAL=1` 把收集工作进程压到一个（Next 16.4 起 `experimental.cpus` 已不在公开配置里，写进配置只会告警），即可在上限内完成编译、路由收集与静态生成；类型检查用 `tsc --noEmit` 单独验证。这些不要写回仓库（16.4 起构建不再跑 lint，`eslint` 配置项同样只会告警）。
- Next 16.4 的构建主进程在页面数据收集阶段会涨到 1.5G 以上，1.7G 上限仍会被 cgroup 杀掉；给构建进程设 `NODE_OPTIONS=--max-old-space-size=900` 后峰值可压到上限以内。重活建议用临时 service 而非 scope 跑（`systemd-run --unit=<名字> --wait --pipe -p MemoryMax=… -p OOMScoreAdjust=900 …`），既限内存又让它在全局内存紧张时优先被杀。
- 本机内存下全新 `npm ci` 跑不完（npm 自身峰值 >1.5G，两次被杀）。升级依赖时改为：把生产 `node_modules` **完整实拷贝**（`cp -a`，不要用硬链接——npm 会原地改写 `.package-lock.json` 等文件，写穿到生产）到副本，再做增量 `npm install --ignore-scripts --prefer-offline`，然后单独补跑 `node node_modules/prisma/build/index.js generate` 与 `node scripts/copy-file-viewer-assets.mjs`。
- Prisma 生成的客户端与 `.next` 的服务端/静态代码块都不含构建目录的绝对路径，副本里构建的产物可以直接 `mv` 进生产目录；`.env.production` 里的连接串不会被写进产物。
- 生产构建只能以 SSO 模式运行（启动守卫禁止非 development 环境开 `MOCK_AUTH`）；需要登录态时，用沙箱自己的 `AUTH_SECRET` 签 `bm_session` cookie（沙箱 `APP_BASE_URL` 是 https 时，cookie 名为 `__Host-bm_session`）。
- 做完用 `find node_modules .next -newermt '<开始时间>'` 确认生产目录零改动，再删除副本与容器。
- 测试里给 Prisma 委托做故障注入不要用 `vi.spyOn(...).mockRestore()`（本仓库的 Vitest 1.6 会把方法留成 `undefined`，污染同进程后续用例）：手工替换方法再赋回。
- 用项目依赖里的 `playwright` 包写脚本时，它要求的 chromium 版本可能与已安装的不一致：用 `chromium.launch({ executablePath })` 指向 `~/.cache/ms-playwright/chromium_headless_shell-*/` 下已有的可执行文件即可，不必下载。带动画的界面（如移动端抽屉）要等动画结束再量尺寸、截图。

## Browser automation

playwright-cli 浏览器自动化使用 chromium：本机未安装 Chrome 发行版（`/opt/google/chrome/chrome` 不存在，安装需 sudo),`playwright-cli open` 必须带 `--browser=chromium`(Playwright 自带 chromium 已装在 `~/.cache/ms-playwright/`)。截图等临时产物已被 `.gitignore`(`*.png`、`.playwright-cli/`)。
