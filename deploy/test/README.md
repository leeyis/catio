# Catio Test Fixtures — Docker Compose

This directory contains a `docker-compose.yml` that spins up all server-engine databases used by the Rust integration test suite.

## Purpose

The Catio database backend supports ~30 engines. Server-engine integration tests (Postgres, MySQL, SQL Server, ClickHouse, Elasticsearch, rqlite, MongoDB, Redis) are gated by environment variables: if the variable is absent the test prints a skip message and returns. This compose file brings up all of those engines on the exact ports and with the exact credentials the tests expect.

SQLite and DuckDB tests are **embedded** (in-process) and require **no docker**. Pure-function / unit tests also require no docker.

---

## Start the services

```bash
# Start all engines in the background
docker compose -f deploy/test/docker-compose.yml up -d

# Or wait until every healthcheck passes before returning
docker compose -f deploy/test/docker-compose.yml up --wait
```

---

## Export test environment variables

### Bash / WSL

```bash
export CATIO_TEST_PG_URL=127.0.0.1:55432:postgres:pw:postgres
export CATIO_TEST_MYSQL_URL=127.0.0.1:53306:root:pw:catio
export CATIO_TEST_MSSQL_URL=127.0.0.1:51433:sa:Catio_pw1:master
export CATIO_TEST_CLICKHOUSE_URL=127.0.0.1:58123:default::default
export CATIO_TEST_ES_URL=127.0.0.1:59200::::
export CATIO_TEST_RQLITE_URL=127.0.0.1:54001::::
export CATIO_TEST_MONGO_URL=127.0.0.1:57017:::catio_test
export CATIO_TEST_REDIS_URL=127.0.0.1:56379::::
```

### PowerShell

```powershell
$env:CATIO_TEST_PG_URL       = "127.0.0.1:55432:postgres:pw:postgres"
$env:CATIO_TEST_MYSQL_URL    = "127.0.0.1:53306:root:pw:catio"
$env:CATIO_TEST_MSSQL_URL    = "127.0.0.1:51433:sa:Catio_pw1:master"
$env:CATIO_TEST_CLICKHOUSE_URL = "127.0.0.1:58123:default::default"
$env:CATIO_TEST_ES_URL       = "127.0.0.1:59200::::"
$env:CATIO_TEST_RQLITE_URL   = "127.0.0.1:54001::::"
$env:CATIO_TEST_MONGO_URL    = "127.0.0.1:57017:::catio_test"
$env:CATIO_TEST_REDIS_URL    = "127.0.0.1:56379::::"
```

The URL format parsed by each test is `host:port:user:password:dbname` (colons as separators; empty fields are allowed).

---

## Run the full test suite

```bash
cd src-tauri
cargo test
```

All engine integration tests + pure-function tests + embedded-engine tests (SQLite / DuckDB) will run. Server-engine tests skip gracefully if the matching env var is absent.

### Space-constrained machines — redirect the Cargo target directory

The default `target/` directory inside `src-tauri` can grow large (several GB of build artefacts). During development this project redirected it to a separate drive:

```bash
# Bash / WSL
export CARGO_TARGET_DIR=F:/cargo-targets/catio-db-backend
cd src-tauri && cargo test
```

```powershell
# PowerShell
$env:CARGO_TARGET_DIR = "F:/cargo-targets/catio-db-backend"
Set-Location src-tauri
cargo test
```

You can substitute any path on a drive with sufficient free space.

---

## Stop and remove the services

```bash
docker compose -f deploy/test/docker-compose.yml down -v
```

The `-v` flag removes the anonymous volumes created for the databases, giving you a clean slate for the next run.

---

## Service summary

| Service        | Image                                              | Host port | Test env var                   |
|----------------|---------------------------------------------------|-----------|-------------------------------|
| postgres       | postgres:16                                        | 55432     | `CATIO_TEST_PG_URL`           |
| mysql          | mysql:8                                            | 53306     | `CATIO_TEST_MYSQL_URL`        |
| mssql          | mcr.microsoft.com/mssql/server:2022-latest        | 51433     | `CATIO_TEST_MSSQL_URL`        |
| clickhouse     | clickhouse/clickhouse-server:24-alpine            | 58123     | `CATIO_TEST_CLICKHOUSE_URL`   |
| elasticsearch  | docker.elastic.co/elasticsearch/elasticsearch:8.15.0 | 59200  | `CATIO_TEST_ES_URL`           |
| rqlite         | rqlite/rqlite                                     | 54001     | `CATIO_TEST_RQLITE_URL`       |
| mongo          | mongo:7                                           | 57017     | `CATIO_TEST_MONGO_URL`        |
| redis          | redis:7-alpine                                    | 56379     | `CATIO_TEST_REDIS_URL`        |
