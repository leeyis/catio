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

## Phase 1 — 原生协议全族（约 28 引擎，主要前端）
- [x] 调研：driver_profile 机制、postgres/mysql 已有分支、DBX SCHEME_PROFILES 映射
- [ ] 后端：postgres.rs `default_database` 补 highgo；单测
- [ ] 前端：新建 `src/services/dbEngines.ts` 引擎目录（分组）；NewConnectionModal 用目录 + 透传 driverProfile（当前**漏传**）
- [ ] logos：补缺失品牌图标 / 短码兜底
- [ ] i18n：分组标签 en/zh
- [ ] 测试：vitest 目录测试；Docker 集成（PG/CockroachDB/MySQL/MariaDB/TiDB/StarRocks/ClickHouse 等有公开镜像者）

## Phase 2 — JDBC sidecar（约 30 引擎：Oracle/DB2/Snowflake/...）
- [ ] Java Maven plugin（蓝本 DbxJdbcPlugin.java）→ `src-tauri/jdbc-plugin/`，构建 fat jar
- [ ] 后端：DatabaseType 增 `Jdbc`；capabilities/dialect；`drivers/jdbc.rs` 经 sidecar 实现 Driver trait
- [ ] 引擎→JDBC URL 模板 + driver class 映射
- [ ] 构建/打包集成 + 驱动 jar 路径管理
- [ ] 前端：JDBC 引擎入目录 + 驱动 jar 字段
- [ ] 测试：H2 端到端集成（纯 Java 嵌入，无需外部服务器）

## 验收标准
- `cargo test` 全过；`npm test`（vitest）全过；`cargo build`/`tsc` 无错。
- 数据库查询、表格数据编辑（DML 预览/应用）、schema/结构/ER 等现有功能在新引擎上正常。
- 有公开 Docker 镜像的引擎做真实连接+查询+编辑往返验证。
