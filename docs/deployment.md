# 生产部署指南（内网 + Authentik SSO）

本文面向**内网环境部署**：内网已有 Authentik，应用以 Docker 容器运行。开发/本地体验见 [README 快速开始](../README.md#-快速开始)。

部署整体流程：

```
Authentik 建应用 → 准备 PostgreSQL → 构建镜像 → 启动容器 → 引导首个管理员
```

## 前置条件

- 部署机已安装 Docker（构建机另需可访问 npm 源，离线场景见下文）。
- 一个 PostgreSQL 16 实例（新建空库即可， schema 由应用容器启动时自动迁移）。
- 内网 Authentik 的**管理后台权限**（建 Provider/Application）。
- 应用容器能网络可达 Authentik（OIDC discovery）与 PostgreSQL。

> 附件以 `Bytes` 存在数据库内（`prisma/schema.prisma` 的 `RecordAttachment`），**无独立文件卷**，唯一有状态的是 PG 数据。

## 1. Authentik 侧：新建 Provider + Application

1. **Applications → Providers → Create**，类型选 _OAuth2/OpenID Connect_：
   - Client type: **Confidential**
   - Redirect URI: `<预算系统对外地址>/api/auth/callback`（如 `http://192.168.x.x:3000/api/auth/callback`）
   - Subject mode: **User ID**
2. **Applications → Applications → Create**，关联上述 Provider，**slug 建议 `budget`**（issuer 路径由它决定）。
3. 记下 **Client ID / Client Secret**。
4. 确认目标用户能访问该 Application（按需绑定用户/分组，或放开访问策略）。

## 2. 准备 PostgreSQL

二选一：

- **用已有内网 PG（推荐生产）**：建空库与账号即可，无需手动建表。
- **用仓库自带 `docker-compose.yml`**（postgres:16-alpine）：注意其端口默认只绑宿主机回环（`127.0.0.1:5434`，安全加固项），容器化的应用连不到。同机部署时用下方 compose 方式让两者同网络直连，不对宿主机发布数据库端口。

## 3. 构建镜像

构建机（可访问 npm 源）上：

```bash
docker build -t budget-management .
```

镜像为多阶段构建，运行 standalone 产物；入口脚本先执行 `prisma migrate deploy`（幂等）再起服务，**空库可直接启动**，无手动迁移步骤。

**离线内网**：`docker save budget-management | gzip > bm.tar.gz` 拷贝到部署机后 `docker load`。

## 4. 配置与启动

### 环境变量

`src/lib/env.ts` 启动强校验，缺项直接起不来（fail fast）：

| 变量                      | 必填 | 说明                                                                                                                          |
| ------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | ✅   | 生产 PG 连接串（如 `postgresql://user:pass@host:5432/budget?schema=public`）                                                  |
| `MOCK_AUTH`               | ✅   | **必须 `false`**。生产（`NODE_ENV=production`）配 `true` 会启动即崩（mock 模式仅凭 `x-mock-user-id` header 即可冒充任意用户） |
| `AUTHENTIK_ISSUER`        | ✅   | `<authentik地址>/application/o/<slug>/`，与第 1 步 slug 一致，**末尾带 `/`**                                                  |
| `AUTHENTIK_CLIENT_ID`     | ✅   | 第 1 步获取                                                                                                                   |
| `AUTHENTIK_CLIENT_SECRET` | ✅   | 第 1 步获取                                                                                                                   |
| `AUTH_SECRET`             | ✅   | `openssl rand -base64 32` 生成（≥32 字符），会话 JWT 签名密钥；**重部署/迁移机器不要更换**，否则全体登录态失效                |
| `APP_BASE_URL`            | ✅   | 用户浏览器实际访问的地址。反代终止 TLS 写 `https://…`，纯 http 内网写 `http://…`                                              |
| `RUN_MIGRATIONS`          |      | `false` 跳过容器内迁移（改由外部 Job 统一执行时用）                                                                           |
| `APP_PORT`                |      | 默认 3000                                                                                                                     |
| `MAX_ATTACHMENT_BYTES` 等 |      | 上传/导入/请求体等上限，默认值见 [.env.example](../.env.example) 注释                                                         |

内网 http 场景已由代码适配，无需额外配置：

- issuer 为 `http:` 时自动放开 openid-client 的 HTTPS 限制（`src/lib/auth/oidc.ts` 的 `allowInsecureRequests`）；
- 会话 cookie 的 `Secure` 标记按 `APP_BASE_URL` 协议推导（而非 NODE_ENV）——纯 http 部署不会因 Secure cookie 被浏览器拒收回传。

### compose 编排示例（同机起 PG + 应用）

```yaml
# docker-compose.prod.yml
services:
  app:
    image: budget-management
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://budget:budget@postgres:5432/budget?schema=public
      MOCK_AUTH: 'false'
      AUTHENTIK_ISSUER: http://<authentik内网地址>/application/o/budget/
      AUTHENTIK_CLIENT_ID: <Client ID>
      AUTHENTIK_CLIENT_SECRET: <Client Secret>
      AUTH_SECRET: <openssl rand -base64 32 生成>
      APP_BASE_URL: http://<预算系统对外地址>
    ports:
      - '3000:3000'
    depends_on:
      postgres:
        condition: service_healthy
  postgres:
    ports: [] # 不对宿主机发布,仅容器网络内访问
```

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

或单容器直连已有 PG：

```bash
docker run -d -p 3000:3000 --env-file .env.production budget-management
```

容器自带健康检查 `GET /api/health`（做 DB ping，区分「进程活着」与「能服务」），可对接编排系统探针。

### 反向代理（可选）

若经 Nginx 等反代对外（统一域名/终止 TLS）：`APP_BASE_URL` 填**用户实际访问的对外地址**（redirect_uri 由它拼接，`oidc.ts` 的 `oidcRedirectUri()`），Authentik 侧 Redirect URI 同步改为该对外地址。应用本身从 `APP_BASE_URL` 取值构造回调，不依赖 `X-Forwarded-*`。

## 5. 引导首个管理员

SSO 首次登录走 **JIT 自动建档**（默认 `USER`，全局只读）。第一个管理员：

1. 用自己的 Authentik 账号登录一次系统（完成建档）。
2. 在**有仓库代码的机器**（运维机/开发机）上，把 `DATABASE_URL` 指向生产库执行提升脚本：

   ```bash
   DATABASE_URL="postgresql://…生产库…" npx tsx scripts/make-admin.ts <显示名 或 SSO sub UUID>
   ```

   > 该脚本不在应用镜像内（standalone 镜像仅含运行时），不能 `docker exec` 进容器执行。
   > 若 Authentik 回调按「显示名优先」建档，Authentik 登录名不入库，请传**显示名**或 **sub UUID**；
   > 同名多行时脚本会拒绝并要求用 UUID 精确指定（防绑错账号，见 `scripts/make-admin.ts`）。

3. 之后所有授权都在界面内完成：管理员在项目概览页「成员管理」把用户加为 OWNER（可编辑预算）/ HANDLER（仅录入）；全局角色只有 ADMIN / USER 两级，日常无需再碰数据库。

**不要执行 `npm run db:seed`**——那是写入 mock 用户的开发数据，SSO 生产环境用不上。

## 6. 用户主机接入（Coding Agent，Windows 适用）

内网用户在自己电脑上经 coding agent（ZCode / Codex 等）操作系统的最简形态——**无需 curl / jq / node_modules / 互联网**，只需 Python ≥ 3.8（标准库即可；离线环境用官方安装包离线分发 Python）：

1. **签发凭证**：用户登录系统，在「API 凭证」页自助签发**个人凭证**（读写档、按需项目范围、可选有效期），明文仅创建时可见。
2. **拷贝 2 个文件**：把仓库 `skills/budget-ops/` 下的 `SKILL.md` 与 `budget.py` 复制到用户主机的 `~/.agents/skills/budget-ops/`（Windows 为 `%USERPROFILE%\.agents\skills\budget-ops\`）。
3. **初始化配置**（交互输入 Base URL 与 API Key，自动探测连通性并校验凭证，写 `~/.budget-agent.json`）：

   ```bash
   python budget.py setup
   ```

4. **自检**：

   ```bash
   python budget.py doctor
   ```

之后 agent 会话按 SKILL.md 用 `python budget.py api/upload …` 操作系统。要点：

- 认证走 Bearer API Key，**不经过 Authentik**——用户主机只需内网可达预算系统，无需访问 SSO。
- 配置解析顺序：`BUDGET_BASE_URL` / `BUDGET_TOKEN` 环境变量 > `~/.budget-agent.json`（`BUDGET_CONFIG` 可指定路径）。
- 内网自签 https 时给助手加 `--insecure`（或 `BUDGET_INSECURE=1`）。
- **安全**：凭证等同本人身份，疑似泄露立即在「API 凭证」页撤销；便携主机不要放无人值守全范围服务账号 key。
- **无人值守场景**（定时收件箱导入等）：凭证由管理员在有仓库代码的机器上 `npm run make-agent` 签发（离线准备同第 5 节），跑在常开机器上，而非便携客户端。
- **MCP 接入为可选项**：离线客户端默认不用（官方 `npx tsx` 启动方式需联网）；确需时自行预打包单文件 bundle。

## 7. 升级

```bash
# 构建机
git pull && docker build -t budget-management:vX.Y.Z .
docker save … # 离线则 save/load 传输

# 部署机
docker load … && docker compose -f … up -d   # 换镜像 tag 后重建容器
```

入口脚本对新镜像自动执行 `migrate deploy`，无手动迁移步骤；`AUTH_SECRET` 沿用原值。

## 8. 验证清单

- 浏览器打开 `APP_BASE_URL` → 跳转 Authentik 登录 → 回跳后右上角显示你的姓名（JIT 建档成功）。
- `make-admin` 后重新登录，侧边栏出现管理功能。
- `GET /api/health` 返回 `"ok"`（DB 可达）。
- 上传一个附件并在线预览（附件落库读写正常）。

## 附录：安全红线速查

| 红线                                   | 原因                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------- |
| 生产 `MOCK_AUTH=true` 启动即崩         | mock 模式仅凭 header 冒充任意用户（`src/lib/boot-guard.ts`）                |
| `AUTH_SECRET` 泄露/随意更换            | 泄露=可伪造登录态；更换=全体会话失效                                        |
| 数据库端口不对宿主机/局域网发布        | compose 默认只绑回环即此加固项；远程运维走 SSH 隧道                         |
| 凭证/用户管理 API 拒绝一切 Bearer 凭证 | 防机器凭证自我签发/提权（仅限管理员登录会话），见 [AGENTS.md](../AGENTS.md) |
