#!/bin/sh
# 一键构建镜像并组装内网离线部署包(bundle)。
#
# 在有 Docker 与 npm 源访问的构建机上执行;产物 dist/budget-deploy_<版本>/ 拷入内网后,
# 按 bundle 内的 DEPLOY-OFFLINE.md 操作(docker load → 填 .env.production → compose up)。
set -eu

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "错误: Docker 不可用(未安装或守护进程未运行)" >&2
  exit 1
fi

version=$(node -p "require('./package.json').version")
echo "==> budget-management v${version}"

echo "==> docker build(双 tag: <版本> + latest)"
# 构建机网络受限时注入镜像/npm 源覆盖(与 Dockerfile 内 ARG 对应):
#   NODE_IMAGE=docker.m.daocloud.io/library/node:20-alpine \
#   NPM_REGISTRY=https://registry.npmmirror.com sh scripts/pack-deploy-bundle.sh
# 镜像名可覆盖:内网已有自定义命名的栈沿用原名升级,如
#   IMAGE_NAME=budget-management-app sh scripts/pack-deploy-bundle.sh
IMAGE_NAME="${IMAGE_NAME:-budget-management}"
build_args=""
[ -n "${NODE_IMAGE:-}" ] && build_args="${build_args} --build-arg NODE_IMAGE=${NODE_IMAGE}"
[ -n "${NPM_REGISTRY:-}" ] && build_args="${build_args} --build-arg NPM_REGISTRY=${NPM_REGISTRY}"
[ -n "${APK_MIRROR:-}" ] && build_args="${build_args} --build-arg APK_MIRROR=${APK_MIRROR}"
# shellcheck disable=SC2086 # build_args 需按空格分词
docker build ${build_args} -t "${IMAGE_NAME}:${version}" -t "${IMAGE_NAME}:latest" .

echo "==> docker save(双 tag 同存,内网 load 后 latest 自动指向本版)"
mkdir -p "dist/budget-deploy_${version}"
docker save "${IMAGE_NAME}:${version}" "${IMAGE_NAME}:latest" \
  | gzip > "dist/budget-deploy_${version}/${IMAGE_NAME}_${version}.tar.gz"

echo "==> 组装 bundle 文件"
cp docker-compose.prod.yml "dist/budget-deploy_${version}/"
cp .env.production.example "dist/budget-deploy_${version}/"
cp docker/DEPLOY-OFFLINE.md "dist/budget-deploy_${version}/"

echo "==> 完成: dist/budget-deploy_${version}/"
ls -lh "dist/budget-deploy_${version}"
