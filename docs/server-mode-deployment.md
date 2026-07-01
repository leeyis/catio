# Catio Server 模式部署指南

本文面向第一次部署 Catio Server 模式的同学，目标是把 Catio 部署到一台 Linux 服务器上，然后通过浏览器访问：

```text
http://<服务器IP>:8787
```

Server 模式使用 `catio-server` 这个 Rust 二进制提供 HTTP / WebSocket 服务，同时托管前端 `dist/` 静态文件。它和桌面端共用核心能力，但运行方式不同：桌面端是本机 Tauri 应用，Server 模式是服务器进程 + 浏览器访问。

## 适用场景

- 小团队在局域网内共用一台 Catio 服务。
- 服务器能访问目标数据库、SSH 主机或内网资产。
- 使用浏览器访问 Catio，不希望每台电脑都安装桌面客户端。

不建议直接暴露到公网。需要公网访问时，应放在 VPN、堡垒机、内网网关或 HTTPS 反向代理之后，并限制访问来源。

## 当前限制

- Server 模式当前监听 `0.0.0.0:<CATIO_PORT>`，默认端口是 `8787`。
- Server 模式需要前端 `dist/`，不能只部署一个二进制文件。
- 当前 `catio-server` 仍会间接链接 Tauri / WebKit 相关动态库。裸二进制部署时，即使不打开桌面窗口，也要安装这些系统库。
- JDBC 长尾数据库在 Server 模式下还不是默认可用路径。当前 Docker 镜像不带 JRE 和 JDBC plugin jar，JDBC 引擎连接会失败；优先使用原生支持的 PostgreSQL、MySQL、SQLite、SQL Server、DuckDB、MongoDB、Redis、ClickHouse 等。
- 本地文件路径类能力在 Server 模式下语义不同：浏览器用户的本机路径不是服务器路径。涉及本机导入导出时，以界面实际可用能力为准。

## 双模式支持矩阵

Catio 在同一个代码库里维护桌面客户端和 Server 模式。两者共用 React UI 和 Rust 核心模块，但入口、传输层、凭据保存位置不同。

| 能力 | 桌面客户端 | Server / Docker 模式 | 说明 |
|---|---|---|---|
| 发布入口 | `catio` Tauri 应用 | `catio-server` HTTP/WS 服务 | 两个二进制入口分别构建，不互相替代。 |
| 前端运行时 | Tauri WebView | 浏览器 | Server 由后端注入 `window.__CATIO_SERVER__=true`。 |
| 后端调用 | Tauri `invoke` / event | `/api/invoke` / `/ws` | `src/services/transport.ts` 负责分流。 |
| 用户与数据隔离 | 本机单用户数据 | Server 登录、多用户数据隔离 | Server 模式需要先创建管理员账号。 |
| SSH 连接与远程终端 | 支持 | 支持 | Server 模式终端流走 WebSocket。 |
| 终端复制/粘贴 | 支持 | 支持 | Server 模式兼容 HTTP 下 Clipboard API 受限场景。 |
| SFTP 浏览与基础文件操作 | 支持 | 支持 | 浏览器本机路径不等于服务器路径，涉及本机文件导入导出时以界面能力为准。 |
| SSH Tunnel / SOCKS | 支持 | 支持 | Tunnel 在服务器进程所在机器上建立。 |
| Agentless 监控 | 支持 | 支持 | Server 模式监控流走 WebSocket。 |
| 原生数据库驱动 | 支持 | 支持 | PostgreSQL、MySQL、SQLite、SQL Server、DuckDB、MongoDB、Redis、ClickHouse 等优先走原生路径。 |
| JDBC 长尾数据库 | 支持 | 默认不支持 | 当前 Docker 镜像未带 JRE 和 JDBC plugin jar；需要后续补镜像和运行时接线。 |
| MCP | 桌面本机 MCP 服务 | Server MCP 路由与用户 token | Server 模式要配置访问地址和可选 IP 白名单。 |
| Auto Scan | 支持 | 管理员可用 | Server 模式扫描发生在服务器网络视角。 |
| Local terminal / Serial / RDP | 支持或依赖本机环境 | 不作为 Server 默认能力 | 这些能力依赖访问者本机或桌面环境，Server 模式会隐藏或限制入口。 |

## 部署方式选择

| 方式 | 推荐场景 | 优点 | 注意事项 |
|---|---|---|---|
| Docker 部署 | 首次部署、内网测试、小团队使用 | 依赖最少，环境一致，升级回滚简单 | 需要服务器安装 Docker |
| 二进制部署 | 不允许 Docker、已有系统运维规范 | 可接入 systemd、目录和权限更透明 | 要处理运行库、glibc、Node/Rust 构建环境 |

初级部署优先选 Docker。二进制部署适合有 Linux 运维经验的环境。

## 通用环境变量

Docker 和二进制部署都使用这些环境变量：

| 变量 | 默认值 | 是否建议配置 | 说明 |
|---|---:|---|---|
| `CATIO_PORT` | `8787` | 可选 | HTTP 服务端口。 |
| `CATIO_STATIC` | `dist` | 必填或保持镜像默认 | 前端静态文件目录。Docker 镜像中是 `/app/dist`。 |
| `CATIO_DATA` | `data` | 必填或保持镜像默认 | 数据目录，保存用户、会话相关数据库和持久化数据。 |
| `CATIO_MASTER_KEY` | 无 | 强烈建议 | 用于加密保存连接密码。未配置时，Server 模式无法保存连接密码。 |
| `CATIO_ADMIN_USER` | 无 | 首次部署建议 | 首次启动时自动创建管理员。已有用户后不会重复创建。 |
| `CATIO_ADMIN_PASSWORD` | 无 | 首次部署建议 | 初始管理员密码。部署完成后建议从环境文件移除。 |
| `CATIO_MAX_UPLOAD_BYTES` | 无限制 | 可选 | 限制单次 SFTP 上传大小，单位是字节。 |
| `CATIO_MCP_IP_ALLOWLIST` | 空 | 可选 | MCP 路由 IP 白名单，支持 IPv4 或 CIDR，逗号分隔。 |
| `CATIO_TRUST_PROXY` | `false` | 反代场景可选 | 为 `true` 时信任 `X-Forwarded-For` 的客户端 IP。 |

生成 `CATIO_MASTER_KEY`：

```bash
openssl rand -base64 32
```

如果服务器没有 `openssl`，先安装：

```bash
sudo apt update
sudo apt install -y openssl
```

## 方式一：Docker 部署

### 1. 准备服务器

示例以 Ubuntu 为例。先确认 Docker 可用：

```bash
docker --version
```

如果没有 Docker，先按服务器操作系统安装 Docker Engine。安装完成后，建议让当前用户能运行 Docker，或者后续命令统一加 `sudo`。

### 2. 拉取代码并构建镜像

```bash
git clone <你的仓库地址> catio
cd catio

DOCKER_BUILDKIT=1 docker build -t catio-server:local .
```

构建过程会做三件事：

1. 用 Node 构建前端 `dist/`。
2. 用 Rust 构建 `catio-server`。
3. 生成只包含运行所需文件的 runtime 镜像。

### 3. 创建环境文件

不要把密码直接写在命令行里，避免进入 shell history。创建一个只允许 root 读取的环境文件：

```bash
sudo mkdir -p /etc/catio
sudo nano /etc/catio/catio.env
```

写入以下内容，并把 `CHANGE_ME...` 替换成真实值：

```env
# 先运行 openssl rand -base64 32，把输出填到这里
CATIO_MASTER_KEY=CHANGE_ME_GENERATED_MASTER_KEY
CATIO_ADMIN_USER=admin
CATIO_ADMIN_PASSWORD=CHANGE_ME_STRONG_PASSWORD
```

保存后设置权限：

```bash
sudo chmod 600 /etc/catio/catio.env
```

### 4. 启动容器

```bash
docker volume create catio-data

docker run -d \
  --name catio-server \
  --restart unless-stopped \
  -p 8787:8787 \
  --env-file /etc/catio/catio.env \
  -v catio-data:/app/data \
  catio-server:local
```

检查容器状态：

```bash
docker ps --filter name=catio-server
docker logs -f catio-server
```

如果日志中看到类似输出，说明服务已启动：

```text
catio-server listening on http://0.0.0.0:8787
```

### 5. 验证访问

在服务器上执行：

```bash
curl http://127.0.0.1:8787/healthz
```

正常应返回：

```text
ok
```

在浏览器访问：

```text
http://<服务器IP>:8787
```

如果服务器启用了防火墙，需要放行端口：

```bash
sudo ufw allow 8787/tcp
sudo ufw status
```

### 6. 首次登录

如果配置了 `CATIO_ADMIN_USER` 和 `CATIO_ADMIN_PASSWORD`，首次启动会自动创建管理员。使用该账号登录。

登录成功后，建议从 `/etc/catio/catio.env` 删除 `CATIO_ADMIN_PASSWORD`，然后重建容器但保留同一个 volume：

```bash
docker stop catio-server
docker rm catio-server

docker run -d \
  --name catio-server \
  --restart unless-stopped \
  -p 8787:8787 \
  --env-file /etc/catio/catio.env \
  -v catio-data:/app/data \
  catio-server:local
```

只要 `catio-data` volume 没删，已有用户会保留。

### 7. 升级 Docker 部署

```bash
cd catio
git pull

DOCKER_BUILDKIT=1 docker build -t catio-server:local .

docker stop catio-server
docker rm catio-server

docker run -d \
  --name catio-server \
  --restart unless-stopped \
  -p 8787:8787 \
  --env-file /etc/catio/catio.env \
  -v catio-data:/app/data \
  catio-server:local
```

升级前建议备份数据卷：

```bash
mkdir -p backups
docker run --rm \
  -v catio-data:/data \
  -v "$PWD/backups:/backup" \
  busybox \
  tar czf /backup/catio-data-$(date +%Y%m%d-%H%M%S).tgz -C /data .
```

## 方式二：二进制部署到 Ubuntu

二进制部署不是单文件部署。最终服务器上至少需要：

```text
/opt/catio/catio-server
/opt/catio/dist/
/var/lib/catio/
/etc/catio/catio.env
/etc/systemd/system/catio-server.service
```

推荐在目标 Ubuntu 服务器上构建，或者在与目标系统版本一致的 Ubuntu 容器里构建。不要在 Windows 上直接 `cargo build` 后复制到 Ubuntu，那会生成 Windows 可执行文件。

### 1. 安装运行时依赖

```bash
sudo apt update
sudo apt install -y \
  ca-certificates \
  openssl \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1 \
  librsvg2-2 \
  libudev1
```

如果系统提示找不到 `libwebkit2gtk-4.1-0`，说明当前 Ubuntu 软件源与项目依赖不匹配。此时优先使用 Docker 部署，或换用与构建环境一致的 Ubuntu / Debian 版本。

### 2. 安装构建依赖

如果你只拿到了别人构建好的 `catio-server` 和 `dist/`，可以跳过本节。

```bash
sudo apt update
sudo apt install -y \
  build-essential \
  curl \
  git \
  pkg-config \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libxdo-dev \
  libudev-dev
```

安装 Node.js 20+ 和 Rust stable。服务器已有符合版本要求的环境时可以跳过：

```bash
node --version
npm --version
rustc --version
cargo --version
```

如果这些命令不存在，可以按下面的常见方式安装。公司内网环境如果有统一镜像源，应优先使用内部安装规范。

```bash
# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup default stable
```

### 3. 构建前端和 Server 二进制

```bash
git clone <你的仓库地址> catio
cd catio

npm ci
npm run build

cd src-tauri
cargo build --release --bin catio-server
cd ..
```

构建完成后检查文件：

```bash
ls -lh src-tauri/target/release/catio-server
ls -la dist
```

### 4. 安装到系统目录

创建专用用户和目录：

```bash
sudo useradd --system --home /var/lib/catio --shell /usr/sbin/nologin catio || true

sudo mkdir -p /opt/catio /var/lib/catio /etc/catio
sudo cp src-tauri/target/release/catio-server /opt/catio/catio-server
sudo rm -rf /opt/catio/dist
sudo cp -r dist /opt/catio/dist

sudo chown -R root:root /opt/catio
sudo chmod 755 /opt/catio/catio-server
sudo chown -R catio:catio /var/lib/catio
```

### 5. 创建环境文件

```bash
sudo nano /etc/catio/catio.env
```

写入以下内容，并把 `CHANGE_ME...` 替换成真实值：

```env
CATIO_PORT=8787
CATIO_STATIC=/opt/catio/dist
CATIO_DATA=/var/lib/catio
# 先运行 openssl rand -base64 32，把输出填到这里
CATIO_MASTER_KEY=CHANGE_ME_GENERATED_MASTER_KEY
CATIO_ADMIN_USER=admin
CATIO_ADMIN_PASSWORD=CHANGE_ME_STRONG_PASSWORD
```

设置权限：

```bash
sudo chmod 600 /etc/catio/catio.env
sudo chown root:root /etc/catio/catio.env
```

### 6. 创建 systemd 服务

```bash
sudo nano /etc/systemd/system/catio-server.service
```

写入：

```ini
[Unit]
Description=Catio Server
After=network-online.target
Wants=network-online.target

[Service]
User=catio
Group=catio
WorkingDirectory=/opt/catio
EnvironmentFile=/etc/catio/catio.env
ExecStart=/opt/catio/catio-server
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now catio-server
sudo systemctl status catio-server --no-pager
```

查看日志：

```bash
journalctl -u catio-server -f
```

### 7. 验证访问

```bash
curl http://127.0.0.1:8787/healthz
```

正常返回：

```text
ok
```

浏览器访问：

```text
http://<服务器IP>:8787
```

如果外部机器打不开，先检查端口监听和防火墙：

```bash
ss -lntp | grep 8787
sudo ufw allow 8787/tcp
sudo ufw status
```

### 8. 升级二进制部署

先备份数据目录：

```bash
sudo systemctl stop catio-server

sudo tar czf /root/catio-data-$(date +%Y%m%d-%H%M%S).tgz -C /var/lib/catio .
```

重新构建或上传新的 `catio-server` 和 `dist/` 后替换：

```bash
sudo cp src-tauri/target/release/catio-server /opt/catio/catio-server
sudo rm -rf /opt/catio/dist
sudo cp -r dist /opt/catio/dist
sudo chmod 755 /opt/catio/catio-server

sudo systemctl start catio-server
sudo systemctl status catio-server --no-pager
```

## 可选：使用反向代理提供 HTTPS

Server 模式自身只提供 HTTP。需要 HTTPS 时，建议使用 Caddy、Nginx 或网关做 TLS 终止。

示例 Caddy 配置：

```caddyfile
catio.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

启用反向代理后，建议服务器防火墙只对外开放 `80` 和 `443`，不要把 `8787` 直接暴露到公网。Catio 进程仍会监听 `0.0.0.0:8787`，所以必须靠防火墙或安全组限制直连。

## 常见问题

### `curl /healthz` 没有返回 `ok`

先看进程或容器是否启动：

```bash
docker logs catio-server
# 或
journalctl -u catio-server -n 100 --no-pager
```

常见原因：

- 端口 `8787` 被占用。
- `CATIO_STATIC` 指向的 `dist/` 不存在。
- 二进制缺少系统动态库。

### 浏览器打开后页面空白或资源 404

检查 `CATIO_STATIC`：

```bash
ls -la /opt/catio/dist
ls -la /opt/catio/dist/index.html
```

Docker 部署下不需要手动设置，镜像默认是 `/app/dist`。二进制部署必须指向真实的前端构建目录。

### 登录后无法保存连接密码

检查是否配置了 `CATIO_MASTER_KEY`。没有这个变量时，Server 模式不能保存连接密码。

修改环境文件后重启：

```bash
docker restart catio-server
# 或
sudo systemctl restart catio-server
```

### 改了 `CATIO_ADMIN_PASSWORD` 但新密码不生效

`CATIO_ADMIN_USER` / `CATIO_ADMIN_PASSWORD` 只在数据目录里没有任何用户时创建初始管理员。已有用户后，修改环境变量不会重置密码。

处理方式：

- 登录后在界面里修改密码。
- 或停止服务、备份并清空 `CATIO_DATA`，重新初始化。清空数据会删除已有用户和持久化数据，谨慎操作。

### 二进制启动时报缺少 `.so`

运行：

```bash
ldd /opt/catio/catio-server | grep "not found"
```

按缺少的库安装对应 Ubuntu 包。当前最常见的是 WebKit / GTK / Ayatana / librsvg / udev 相关依赖。

### 二进制提示 glibc 版本不兼容

这是构建系统比运行系统更新导致的。解决方式：

- 在目标 Ubuntu 服务器上重新构建。
- 或在与目标服务器相同版本的 Ubuntu 容器中构建。
- 或改用 Docker 部署。

### Docker 构建很慢

首次构建会下载 npm 包和 Rust crates，时间较长。后续构建会利用 Docker layer cache。建议开启 BuildKit：

```bash
DOCKER_BUILDKIT=1 docker build -t catio-server:local .
```

## 部署后检查清单

- `curl http://127.0.0.1:8787/healthz` 返回 `ok`。
- 浏览器能打开 `http://<服务器IP>:8787`。
- 已创建管理员账号，并能登录。
- `CATIO_MASTER_KEY` 已配置，连接密码可以保存。
- `CATIO_DATA` 使用持久化目录或 Docker volume。
- 防火墙只开放必要端口。
- 没有把 `8787` 直接暴露到公网。
- 已记录数据备份和升级流程。

## 合并 main 前的双模式门槛

每次把 Server 模式相关改动合入 `main` 前，至少确认桌面客户端和 Server 入口都能构建：

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --bin catio
cargo check --manifest-path src-tauri/Cargo.toml --bin catio-server
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Docker 镜像也要做一次 smoke test，确认镜像能启动、`/healthz` 可用，并且首页注入了 Server 模式标记：

```bash
DOCKER_BUILDKIT=1 docker build -t catio-server:smoke .

docker run -d \
  --name catio-server-smoke \
  -p 8787:8787 \
  -e CATIO_MASTER_KEY="MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" \
  -e CATIO_ADMIN_USER="admin" \
  -e CATIO_ADMIN_PASSWORD="admin123" \
  catio-server:smoke

curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/ | grep "__CATIO_SERVER__=true"

docker rm -f catio-server-smoke
```

仓库的 `.github/workflows/dual-mode.yml` 会在 `main` 和 PR 上自动执行这些门槛。正式发版前仍建议在目标操作系统上额外跑一次 `npm run tauri build`，确认安装包签名、系统依赖和平台打包流程都正常。
