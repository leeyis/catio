# catio JDBC sidecar

A small Java process that bridges catio to engines with no native Rust driver
(Oracle, DB2, Snowflake, Hive, Trino, Cassandra, Neo4j, SAP HANA, …). It speaks
a newline-delimited JSON line protocol over stdin/stdout; catio's
`db::drivers::jdbc::JdbcDriver` drives it. Adapted from dbx `plugins/jdbc`
(Apache-2.0).

## Build

Requires JDK 17+ and Maven:

```sh
mvn -q -DskipTests package
# → target/catio-jdbc-plugin.jar  (fat jar: jackson + H2 bundled)
```

## Runtime

catio locates the jar via, in order:
1. `CATIO_JDBC_PLUGIN_JAR` (absolute path) — used by tests/dev,
2. `<crate>/jdbc-plugin/target/catio-jdbc-plugin.jar` (the build output above).

The JVM is located via `CATIO_JAVA_BIN`, then `JAVA_HOME/bin/java`, then `java`
on `PATH`.

## Driver JARs

catio does not redistribute proprietary JDBC drivers. Drop each engine's driver
`.jar` into the directory named by `CATIO_JDBC_DRIVERS_DIR`; every `*.jar` there
is passed to the plugin as `jdbc_driver_paths`. **H2 is bundled**, so
`jdbc:h2:*` works with no extra JAR (this powers the end-to-end self-test).

## Test

```sh
mvn test                 # Java unit tests
# Rust end-to-end (embedded H2, no server):
CATIO_TEST_JDBC=1 cargo test --test db_jdbc_h2
```
