#!/usr/bin/env bash
# 在 arm64 Ubuntu 容器中构建可用于 Ubuntu 的 aarch64 .deb 包。
# 用法：在项目根目录执行 ./scripts/build-deb-arm64.sh
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE=catio-deb-builder

echo "==> 构建/更新构建镜像（linux/arm64）..."
docker build --platform linux/arm64 -f Dockerfile.deb -t "$IMAGE" .

echo "==> 在容器内编译并打包（首次较慢，会拉取 crates 与 npm 依赖）..."
docker run --rm --platform linux/arm64 \
    -e CARGO_NET_RETRY=10 \
    -e CARGO_HTTP_MULTIPLEXING=false \
    -e CARGO_NET_GIT_FETCH_WITH_CLI=true \
    -v "$PWD":/app \
    -v catio-node-modules:/app/node_modules \
    -v catio-cargo-registry:/root/.cargo/registry \
    -v catio-cargo-target:/app/src-tauri/target \
    -w /app "$IMAGE" \
    bash -c "rm -rf /app/dist-deb src-tauri/target/release/bundle/deb && npm ci && npm run tauri build -- --bundles deb && mkdir -p /app/dist-deb && cp src-tauri/target/release/bundle/deb/*.deb /app/dist-deb/"

echo "==> 完成。产物位于："
ls -lh dist-deb/*.deb
