# catio JDBC sidecar

A small Java process that bridges catio to engines with no native Rust driver
(Oracle, DB2, Snowflake, Hive, Trino, Cassandra, Neo4j, SAP HANA, …). It speaks
a newline-delimited JSON line protocol over stdin/stdout; catio's
`db::drivers::jdbc::JdbcDriver` drives it. Adapted from dbx `plugins/jdbc`
(Apache-2.0).

## Build / vendoring

The built fat jar is **vendored** at `src-tauri/resources/catio-jdbc-plugin.jar`
and committed to the repo, so `tauri build` needs only Node + Rust — no Maven on
the packaging machine. `tauri.conf.json` bundles that file as an app resource.

Rebuild it (only when the Java source under `src/` changes) with JDK 17+ and Maven:

```sh
# from src-tauri/jdbc-plugin
mvn -q -DskipTests package                       # → target/catio-jdbc-plugin.jar
cp target/catio-jdbc-plugin.jar ../resources/    # re-vendor, then commit
# or, from the repo root, run the helper:  scripts/build-jdbc-plugin.ps1
```

No system Maven? A portable Apache Maven zip + an installed JDK 17 is enough
(no install/PATH changes): point the wrapper at it via `JAVA_HOME` and run `mvn`.

## Runtime

catio locates the jar via, in order:
1. `CATIO_JDBC_PLUGIN_JAR` (absolute path) — set at app startup to the bundled
   resource (`<resources>/catio-jdbc-plugin.jar`); also used by tests/dev. A
   missing or **0-byte** jar is treated as absent, so a broken bundle surfaces a
   clear "plugin jar not found" instead of a cryptic Java error.
2. `<crate>/jdbc-plugin/target/catio-jdbc-plugin.jar` (a fresh `mvn package`
   output) — the dev fallback.

The JVM is located via `CATIO_JAVA_BIN`, then `JAVA_HOME/bin/java`, then `java`
on `PATH`. **End users still need a JRE/JDK 17+ installed** (catio bundles the
plugin jar, not a JVM).

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
