# 预算管理系统 内网离线部署说明

> 本目录为完整离线部署包（镜像 + 编排 + 配置模板 + 本说明）。
> 目标机：内网 Linux + Docker（≥ 20.10，含 `docker compose` v2）。
> 前置：内网已有 **PostgreSQL 16**（准备一个空库与账号即可，建表由容器自动完成）、
> 内网已有 **Authentik** 且具备管理后台权限（建 Provider/Application）。

## 0. 导入镜像

```bash
docker load -i budget-management_<版本>.tar.gz
docker images | grep budget-management   # 应看到 <版本> 与 latest 两个 tag
```

## 1. Authentik 侧：建 Provider + Application

1. Applications → Providers → Create，类型 _OAuth2/OpenID Connect_：
   - Client type: **Confidential**
   - Redirect URI: `<APP_BASE_URL>/api/auth/callback`（即第 3 步填写的用户访问地址）
   - Subject mode: **User ID**
2. Applications → Applications → Create 关联该 Provider，slug 建议 `budget`（决定 issuer 路径）。
3. 记下 **Client ID / Client Secret**，并确认目标用户能访问该 Application。

## 2. 准备数据库

在内网 PostgreSQL 16 上创建空库与账号（示例）：

```sql
CREATE USER budget WITH PASSWORD '<强口令>';
CREATE DATABASE budget OWNER budget;
```

## 3. 配置环境变量

```bash
cp .env.production.example .env.production
vi .env.production   # 填齐全部必填项,文件内有逐项说明
```

要点：

- `AUTH_SECRET`：`openssl rand -base64 32` 生成；**升级/重部署不要更换**（换了全体登录态失效）。
- `APP_BASE_URL`：用户浏览器实际访问地址，须与 Authentik Redirect URI 一致。
- `AUTHENTIK_ISSUER`：`<authentik地址>/application/o/<slug>/`，**末尾带 `/`**。

## 4. 启动

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps        # 等待状态变 healthy
curl http://127.0.0.1:3000/api/health               # 期望 {"status":"ok"}
```

对外端口改 `docker-compose.prod.yml` 的 `ports`（如 `'8080:3000'`），并同步更新 `APP_BASE_URL` 与 Authentik Redirect URI。

## 5. 引导首个管理员

SSO 首次登录为 JIT 自动建档（默认只读 USER）。第一个管理员：

1. 浏览器打开 `APP_BASE_URL`，用自己的 Authentik 账号登录一次（完成建档）；
2. 在部署机上执行镜像内置的提升工具（同名多行会拒绝，需改传 SSO sub UUID）：

   ```bash
   docker exec -it budget-app node docker/make-admin.mjs '<你的显示名>'
   ```

3. 重新登录后侧边栏出现管理功能；此后项目授权都在界面内完成（项目概览 → 成员管理）。

**不要执行 `npm run db:seed`**——那是写入 mock 用户的开发数据。

## 6. 验证清单

- [ ] `GET /api/health` 返回 `{"status":"ok"}`
- [ ] 浏览器访问 `APP_BASE_URL` → 跳转 Authentik 登录 → 回跳后右上角显示你的姓名
- [ ] 提升管理员后重新登录，侧边栏出现管理功能
- [ ] 上传一个附件并在线预览（附件落库读写正常）

## 7. 升级

拿到新版本部署包后：

```bash
docker load -i budget-management_<新版本>.tar.gz   # latest 自动指向新版本
docker compose -f docker-compose.prod.yml up -d    # 重建容器,入口自动执行迁移
```

`AUTH_SECRET` 与数据库保持不动。

## 常见问题

- **容器反复重启/起不来**：`docker logs budget-app`——多为 `.env.production` 缺项（启动强校验 fail fast）或数据库不可达。
- **登录回跳报 redirect_uri 错误**：核对 `APP_BASE_URL`、Authentik Redirect URI、`AUTHENTIK_ISSUER`（末尾 `/`）三者一致。
- **数据库在别的机器**：确认部署机容器到 PG 的网络可达（`DATABASE_URL` 用 PG 主机内网 IP，不要写 localhost）。

## 安全红线

- `MOCK_AUTH` 保持 `false`（true 时生产容器启动即崩，属预期防护）。
- `AUTH_SECRET` 视同密码保管，不泄露、不随意更换。
- 不要把 PostgreSQL 端口发布到部署机之外的局域网。
