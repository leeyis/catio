# 数据库能力回归实验室

用于 Catio 数据库专项的可重复验收，不是生产部署方案。**只能使用隔离测试库和临时凭据；不要复用生产 volume 或连接。**

## 1. 启动测试数据库

需要 Docker Compose v2。在本目录创建一个**不提交到 Git** 的环境文件，例如保存在仓库已忽略的 `.worktrees/database-lab.env`：

```dotenv
CATIO_LAB_PASSWORD=<只用于测试的大小写字母+数字密码>
CATIO_LAB_BIND=127.0.0.1
```

测试 URL 沿用旧测试夹具的 `host:port:user:password:database` 格式，因此此处密码不要包含冒号。这不是 Catio 连接 API 的限制；真实连接使用类型化凭据，特殊字符另有回归覆盖。

```sh
docker compose --env-file .worktrees/database-lab.env -f tests/database-lab/compose.yml up -d --wait
```

| 引擎 | 本机端口 | 说明 |
|---|---:|---|
| PostgreSQL 16 | 55432 | `catio` 数据库 |
| MySQL 8.0 | 53306 | `catio` 数据库 |
| SQL Server 2022 | 51433 | Developer，仅用于开发测试 |
| ClickHouse 24.8 | 58123 | 使用测试账号，非匿名 HTTP |
| MongoDB 7 | 57017 | 测试管理员的认证库为 `admin` |
| Redis 7 | 56379 | requirepass |
| Elasticsearch 8.15 | 59200 | 无认证，始终只绑定 loopback |
| rqlite 8.36 | 54001 | 无认证，始终只绑定 loopback |

SQLite / DuckDB 在进程内测试；JDBC/H2 使用已打包的 sidecar 和本机 JRE/JDK 17+，无需外部服务。

### 旧内核

SQL Server 2022 在旧 Linux 3.10 内核上的 SQLPAL 可能出现调度器故障。`legacy-kernel` profile 提供**独立的 SQL Server 2019 实例**（51434）；它不挂载、不降级 2022 的数据。

```sh
docker compose --env-file .worktrees/database-lab.env -f tests/database-lab/compose.yml --profile legacy-kernel up -d mssql2019
```

### 远程沙箱

有认证的服务可显式设置 `CATIO_LAB_BIND` 为沙箱私网地址。两个无认证的 HTTP 引擎仍保持 loopback。需要从开发机测试时使用 SSH 隧道，或启用 `remote-test` profile，并在环境文件中设置：

```dotenv
CATIO_LAB_CLIENT_CIDR=<唯一被允许的开发机IPv4>/32
CATIO_LAB_PROXY=<仅安装软件时需要的代理，可留空>
```

`es-access` / `rqlite-access` 的 socat 转发只允许该来源地址，端口分别为 59201 / 54002。不要填 `0.0.0.0/0`。relay 从官方 Alpine 包仓库安装 socat；数据库数据不经过外网代理。

## 2. 运行验收

仓库根目录执行：

```powershell
pwsh tests/database-lab/run.ps1 -EnvFile .worktrees/database-lab.env
# 远程沙箱 + 限定来源的 HTTP 转发 + SQL Server 2019：
pwsh tests/database-lab/run.ps1 -EnvFile .worktrees/database-lab.env -Server <sandbox> -RemoteHttpRelays -SqlServerPort 51434
```

脚本明确设置所有服务的 env gate，不打印密码，执行 `--lib` 以及明确列出的 integration test targets。可用 `-OnlyTargets @('db_typed_values','db_binary_engines')` 选择已登记的目标；省略时运行完整矩阵。Windows 默认限制两个 Cargo 并发任务，避免多个 debug linker 吞掉内存；显式 `CARGO_BUILD_JOBS` 优先。**不要用裸 `cargo test` 代替。** 未启用夹具时，单独运行 env-gated test 所得到的 `ok` 不能计作真实服务验收。

前端与类型检查：

```powershell
npx tsc --noEmit
npm test
npm run build
```

## 3. TLS 验收

`tls` profile 使用 Caddy 为 ClickHouse 提供 HTTPS（59443），关闭管理端口和自动 HTTP 重定向，不修改操作系统信任库。

```sh
docker compose --env-file .worktrees/database-lab.env -f tests/database-lab/compose.yml --profile tls up -d clickhouse-tls
```

从该测试容器的 `/data/caddy/pki/authorities/local/root.crt` 取出**公有 CA 证书**，传给 runner 的 `-CaCert`。不要导出 CA 私钥。

如果沙箱时钟有明显偏差，不应为了测试修改整台主机时钟或关闭证书验证。可在开发机运行：

```powershell
pwsh tests/database-lab/New-LabCertificate.ps1 -ServerAddress <sandbox> -OutputDirectory .worktrees/database-lab-tls
```

它创建向前覆盖两天、有效 30 天的临时 CA/服务证书；不安装系统根证书，CA 私钥不落盘。将服务证书与 `server.key` 放在沙箱的受限目录（目录 0700、私钥 0600），通过专用 Caddy override 挂载，`tls` 指向这两个文件，然后以 `root.crt` 作为测试 CA。所有生成文件必须留在被忽略的运行时目录，不可提交。

## 4. 回归覆盖的关键契约

- 分页 N+1：满页、最后一页、已有 LIMIT、尾分号、零页尺寸、多语句/写语句拒绝重放。
- 网格：同名列不串值；脏编辑不跨页；错误不丢失旧页；NULL/空串区分；没有稳定键时不生成无 WHERE 的 UPDATE。
- 写入：预先校验全部编辑；SQL 错误整批回滚；覆盖导入用 DELETE 而非 MySQL TRUNCATE；MyISAM 等非事务表不可冒充可回滚目标。
- 迁移：先完成源数据暂存，再写目标；同连接复制不死锁；暂存或目标失败不清空原数据。暂存预算包含 JSON 转义与换行开销；顶层 BLOB 使用逐单元格类型元数据，不按 hex 外观猜类型；SQLite 混合 storage class 不会把字节静默写成文本。
- 类型：PostgreSQL UUID/NUMERIC/微秒时间；SQL Server GUID/高 scale DECIMAL；DuckDB Arrow DECIMAL(38,s)/嵌套集合；JDBC 大整数与高精度数值。
- 会话与取消：临时表及显式事务状态跨查询保留；运行中的原生查询被实际中断；早到的取消不能漏执行；超时/断开清理登记；忙碌 JDBC sidecar 可断开。
- Web：按字节导入，不读取客户端指定的服务器路径；迁移同时验证源/目标连接所有权。
- HTTP：TLS 开关/自定义 CA 不被忽略；ClickHouse 200 响应体中的错误不能被误报成功。
- Windows：`.cargo/config.toml` 为 MSVC C++ 设置 `/EHsc`；失败事务后的 DuckDB 连接必须仍可查询。

## 5. 明确的验收边界

- 这些测试不证明全部兼容品牌/商业 JDBC 引擎均可用；每一种实际引擎/版本需要自己的夹具与验收。
- 查询标签当前共享连接级 SQL 会话，不是独立事务；独立事务请使用独立连接。
- 原生中断与 timeout 覆盖 PostgreSQL、MySQL、SQLite、DuckDB。其他引擎不得把停止等待描述为已中断；JDBC 可通过断开连接终止 sidecar。
- 事务回滚证明针对 SQL/约束失败。**提交时断网的结果可能不确定，不自动重试写入，应先核对数据。**
- 跨库迁移要求准备期间源表保持稳定；这不是跨数据库一致性快照。暂存上限为 1 GiB。
- 顶层 BLOB 已覆盖 SQLite、DuckDB、PostgreSQL、MySQL、SQL Server、JDBC/H2、rqlite 的键/值编辑、迁移、SQL 恢复；JSON 的无损往返使用 `catio-table-v1`（含 `binaryCells`），普通 CSV/TSV 不携带类型信息。嵌套二进制和长尾 JDBC 方言仍未算完整验收。
- rqlite 使用单请求原子事务（实际 JSON 请求最多 8 MiB），不是跨 HTTP 请求的手动事务。SQL Server 使用普通 batch 保留事务与临时表作用域，不用 RPC 承载独立 BEGIN/COMMIT。
- 完整原生备份恢复、更多引擎的 DDL/执行计划、按标签隔离事务等仍需专项实现，不能用引擎名称数量冒充能力。
- Web 部署允许执行数据库 SQL，不构成操作系统级 SQL 沙箱；只向可信用户开放，尤其是本地嵌入式数据库及 JDBC 驱动。

停止夹具优先使用 `docker compose ... stop`，保留容器和数据。只有明确要重置本实验室时才使用 `down -v`，不要对生产项目执行该命令。

## 6. 可见浏览器验收

```powershell
npm run build
cargo run --manifest-path src-tauri/Cargo.toml --example database_lab_server
```

这个 example 只监听 `127.0.0.1:18877`，使用 `.worktrees/database-lab-web-data`，不读写正常 Catio 用户目录。打开浏览器后创建一次性 QA 管理员，再新建 SQLite `:memory:` 连接。需要测试保存数据库密码时，应在启动进程前设置独立的测试 `CATIO_MASTER_KEY`；保留该 QA 数据目录重跑时，保持测试 key 不变，不要复用生产 key。

建议手工验收步骤：

1. 执行建表、递归插入 205 行、COUNT、同名列 SELECT 的多语句脚本，确认四份独立结果与列值。
2. 刷新库树后打开表，验证每页 100 行时得到 100/100/5，最后一页禁用下一页。
3. 双击修改单元格，确认分页/刷新被脏编辑保护；预览 SQL 有正确 WHERE，保存后刷新值仍保留。
4. 上传两行含中文的 CSV，核对列映射；先清空模式在未输入表名时不能提交；追加后总数变为 207。
5. 用失败 SELECT + INSERT 验证后续语句不执行；取消长递归查询后，新查询仍能正常执行。
6. 检查 Dawn/Amber/Grove 与中英文下的新工具栏、结果标签和真实连接状态。截图只留在忽略目录，不作为源代码提交。

该例是连接真实后端的 Web UI 验收，不等于已完成打包后的桌面 GUI 全量回归。
