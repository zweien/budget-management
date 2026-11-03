# 基础镜像可覆盖:构建机无法直连 Docker Hub(国内网络常见)时用镜像加速器,如
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:20-alpine …
ARG NODE_IMAGE=node:20-alpine

# deps
FROM ${NODE_IMAGE} AS deps
# npm 源同样可覆盖(--build-arg NPM_REGISTRY=https://registry.npmmirror.com)
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package*.json ./
# postinstall 会执行该脚本生成 public/file-viewer 自托管资产(见 scripts/ 内注释)
COPY scripts/copy-file-viewer-assets.mjs ./scripts/
# playwright(devDep)postinstall 会下载浏览器二进制,镜像构建用不到,跳过省时省流量
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --registry=${NPM_REGISTRY}

# builder
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 资产在 deps 阶段由 postinstall 生成(构建上下文不含),显式带入后再 build
COPY --from=deps /app/public/file-viewer ./public/file-viewer
# alpine 缺 openssl CLI 会导致 prisma 平台探测失败、误用 openssl1.1 引擎
RUN apk add --no-cache openssl
# 构建期占位 env:env.ts 启动校验要求 DATABASE_URL(next build 会加载路由模块)。
# 仅用于通过校验,不建立连接;运行时由部署环境注入真实配置。
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    MOCK_AUTH="true"
RUN npx prisma generate
RUN npm run build

# runner
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
# 运行期同样需要 openssl CLI 供 prisma 客户端选择正确引擎
RUN apk add --no-cache openssl
# Next standalone server.js 以 HOSTNAME 作为监听地址,而 Docker 会注入 HOSTNAME=<容器ID>,
# 导致进程绑到容器 IP、127.0.0.1 探针(下方 HEALTHCHECK)全部落空。显式绑 0.0.0.0。
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
# 迁移执行链:standalone 不含 prisma CLI,显式带入(不拷 .bin——单文件 COPY 会物化
# 符号链接,CLI 内部按 __dirname 找 wasm 会失效),入口脚本以 node 直调 CLI 入口
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# 管理员提升工具(SSO 首个 ADMIN 引导;离线内网没有带仓库的机器,在容器内直接执行)
COPY --chown=node:node docker/make-admin.mjs ./docker/make-admin.mjs
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3000
# 就绪探针:/api/health 做 DB ping,区分「进程活着」与「能服务」
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" | grep -q '"ok"' || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
