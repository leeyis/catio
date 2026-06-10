# DB 引擎全量集成计划（feat/db-engines-all）

目标：把 DBX 支持的 40+ 数据库引擎集成进 catio（当前 10 种 DatabaseType）。
范围（用户已确认）：**原生协议全族 + JDBC sidecar**。

## 权威参考
- DBX：`/tmp/dbx-ref`（Apache-2.0）。引擎枚举见 `crates/dbx-core/src/models/connection.rs`；
  JDBC sidecar 蓝本 `plugins/jdbc/src/main/java/app/dbx/jdbc/DbxJdbcPlugin.java`（简单 JSON 行协议）。
- catio 设计：`docs/superpowers/specs/2026-06-07-catio-db-backend-design.md` 第 5/10 节。

## 架构结论
- catio `DatabaseType` 枚举 = 协议族（10 个）。族内变体用 `driver_profile` 区分（postgres.rs / mysql.rs 已分支）。
- 引擎"目录"（用户可见的 40+ 项）= 前端 catalog，每项映射 `{dbType, driverProfile, defaultPort, group}`。

## Phase 1 — 原生协议全族（28 引擎，主要前端）✅ commit 48caf05
- [x] 调研：driver_profile 机制、postgres/mysql 已有分支、DBX SCHEME_PROFILES 映射
- [x] 后端：postgres.rs `default_database` 补 highgo；单测
- [x] 前端：`src/services/dbEngines.ts` 引擎目录（分组）；NewConnectionModal 用目录 + 透传 driverProfile
- [x] logos：oceanbase-oracle 别名；其余短码兜底（既有设计）
- [x] i18n：分组标签 en/zh
- [x] 测试：vitest 目录测试 11 例；真实 Postgres 上 DML 增改删 + 分页往返（db_dml_roundtrip）

## Phase 2 — JDBC sidecar（26 引擎：Oracle/DB2/Snowflake/...）✅ commit cedd2e9
- [x] Java Maven plugin（蓝本 DbxJdbcPlugin.java）→ `src-tauri/jdbc-plugin/`，fat jar（含 H2）
- [x] 后端：DatabaseType 增 `Jdbc`；capabilities；`drivers/jdbc.rs` 经 sidecar 实现 Driver trait
- [x] 引擎→JDBC URL 模板 + driver class 映射（jdbc_config.rs，26 引擎 + 单测）
- [x] 驱动 jar 路径管理：CATIO_JDBC_DRIVERS_DIR；H2 内置（开箱即用）
- [x] 前端：JDBC 引擎入目录（26 项）+ 分组标签
- [x] 测试：H2 端到端集成（db_jdbc_h2，纯 Java 嵌入，连接/查询/DML 往返/introspection 全过）

## 验收结果
- ✅ `cargo test` 全过（lib 77 + 集成，EXIT=0）；`cargo build` 无错。
- ✅ `tsc --noEmit` 无错；`vitest run` 226 例全过。
- ✅ 数据库查询 + 表格数据编辑（DML 增改删）真实验证（WSL Docker / 真实驱动 jar）：
  - Postgres 族：真实 postgres 容器 —— 查询 + DML 增改删 + 分页往返（db_dml_roundtrip）。
  - MySQL 族：真实 mariadb:11.8 容器 —— 查询 + introspection（db_mysql）+ DML 增改删往返（db_dml_roundtrip::mysql_dml）。
  - JDBC / Oracle：真实 Oracle XE 21c 容器 + ojdbc11 驱动 —— 连接/版本/查询/DML 增改删往返/introspection 全过（db_jdbc_engines::jdbc_oracle）。
  - JDBC / H2：嵌入 H2 —— 全流程往返。
  - JDBC / DB2：真实 db2 容器 + db2jcc 驱动 —— 桥接连接成功（驱动加载、JCC 与服务端通信、返回标准 SQLSTATE）；
    DB2 社区镜像首启 catalog 自建库异常（SYSIBMADM 内部错误，镜像问题，非 catio 代码），未跑完整 round-trip。
- ✅ 前端渲染：NewConnectionModal 组件测试断言新引擎（CockroachDB/MariaDB/TiDB/KingbaseES/Oracle/Db2/Snowflake）
  出现在下拉、分组标题渲染、driverProfile 正确透传（native cockroachdb=postgres+profile；jdbc oracle=jdbc+profile）。
- 打包：Tauri 资源打包 jar / 启动时自动 mvn 构建为后续部署项；dev/test 经 CARGO_MANIFEST_DIR 定位。

## 如何在前端看到新引擎
改动在 worktree 分支 `feat/db-engines-all`（不是 main）。在 worktree 目录跑 `npm run dev`，
新建连接 → 数据库 → 引擎下拉即见分组的 54 个引擎。
