# deps
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# postinstall 会执行该脚本生成 public/file-viewer 自托管资产(见 scripts/ 内注释)
COPY scripts/copy-file-viewer-assets.mjs ./scripts/
RUN npm ci

# builder
FROM node:20-alpine AS builder
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
FROM node:20-alpine AS runner
WORKDIR /app
# 运行期同样需要 openssl CLI 供 prisma 客户端选择正确引擎
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
# 迁移执行链:standalone 不含 prisma CLI,显式带入(不拷 .bin——单文件 COPY 会物化
# 符号链接,CLI 内部按 __dirname 找 wasm 会失效),入口脚本以 node 直调 CLI 入口
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app
USER node
EXPOSE 3000
# 就绪探针:/api/health 做 DB ping,区分「进程活着」与「能服务」
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" | grep -q '"ok"' || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
