#!/bin/sh
set -e
# 启动前执行迁移(幂等);RUN_MIGRATIONS=false 可跳过(如由外部 Job 统一执行)。
# 镜像内无 .bin 解析链,直接以 prisma CLI 入口执行。
if [ "${RUN_MIGRATIONS}" != "false" ]; then
  node /app/node_modules/prisma/build/index.js migrate deploy
fi
exec node server.js
