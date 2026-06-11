//! Engine → JDBC connection mapping for the sidecar driver.
//!
//! catio sends the Java plugin a `connection_string` (JDBC URL) + a
//! `jdbc_driver_class`. The user supplies the engine's driver JAR (catio does
//! not redistribute proprietary drivers); the only exception is H2, which is
//! bundled in the plugin jar so `jdbc:h2:*` works out of the box.
//!
//! URL templates + driver classes follow each vendor's documented JDBC form.

use crate::db::DbError;

/// What the sidecar needs to open a connection for a given engine profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JdbcTarget {
    pub url: String,
    pub driver_class: String,
}

/// Build the JDBC URL + driver class for `profile`. `database` may be empty
/// (then the path segment is omitted where the URL form allows it).
///
/// Returns `Unsupported` for an unknown profile so the UI can surface a clear
/// "no JDBC mapping for X" rather than a cryptic driver error.
pub fn build(profile: &str, host: &str, port: u16, database: &str) -> Result<JdbcTarget, DbError> {
    let d = database.trim();
    // `/db` suffix, only when a database was given.
    let slash_db = if d.is_empty() { String::new() } else { format!("/{d}") };

    let (url, class) = match profile {
        // H2 — bundled in the plugin jar. `database` carries the full H2 spec
        // (e.g. "mem:test", "~/data/app", "tcp://host/~/app").
        "h2" => (format!("jdbc:h2:{}", if d.is_empty() { "mem:catio" } else { d }), "org.h2.Driver"),

        "oracle"      => (format!("jdbc:oracle:thin:@//{host}:{port}{slash_db}"), "oracle.jdbc.OracleDriver"),
        "db2"         => (format!("jdbc:db2://{host}:{port}{slash_db}"), "com.ibm.db2.jcc.DB2Driver"),
        "snowflake"   => (format!("jdbc:snowflake://{host}:{port}/{}", query_db(d)), "net.snowflake.client.jdbc.SnowflakeDriver"),
        "hive"        => (format!("jdbc:hive2://{host}:{port}{slash_db}"), "org.apache.hive.jdbc.HiveDriver"),
        "trino"       => (format!("jdbc:trino://{host}:{port}{slash_db}"), "io.trino.jdbc.TrinoDriver"),
        "cassandra"   => (format!("jdbc:cassandra://{host}:{port}{slash_db}"), "com.ing.data.cassandra.jdbc.CassandraDriver"),
        "neo4j"       => (format!("jdbc:neo4j:bolt://{host}:{port}"), "org.neo4j.jdbc.Driver"),
        "dameng"      => (format!("jdbc:dm://{host}:{port}"), "dm.jdbc.driver.DmDriver"),
        "saphana"     => (format!("jdbc:sap://{host}:{port}/{}", if d.is_empty() { String::new() } else { format!("?databaseName={d}") }), "com.sap.db.jdbc.Driver"),
        "teradata"    => (format!("jdbc:teradata://{host}/{}", if d.is_empty() { String::new() } else { format!("DATABASE={d}") }), "com.teradata.jdbc.TeraDriver"),
        "vertica"     => (format!("jdbc:vertica://{host}:{port}{slash_db}"), "com.vertica.jdbc.Driver"),
        "firebird"    => (format!("jdbc:firebirdsql://{host}:{port}{slash_db}"), "org.firebirdsql.jdbc.FBDriver"),
        "exasol"      => (format!("jdbc:exa:{host}:{port}"), "com.exasol.jdbc.EXADriver"),
        "informix"    => (format!("jdbc:informix-sqli://{host}:{port}{slash_db}"), "com.informix.jdbc.IfxDriver"),
        "gbase8s"     => (format!("jdbc:gbasedbt-sqli://{host}:{port}{slash_db}"), "com.gbasedbt.jdbc.IfxDriver"),
        "kingbase"    => (format!("jdbc:kingbase8://{host}:{port}{slash_db}"), "com.kingbase8.Driver"),
        "yashandb"    => (format!("jdbc:yasdb://{host}:{port}{slash_db}"), "com.yashandb.jdbc.Driver"),
        "bigquery"    => (format!("jdbc:bigquery://{host}:{port};ProjectId={d}"), "com.simba.googlebigquery.jdbc.Driver"),
        "iris"        => (format!("jdbc:IRIS://{host}:{port}{slash_db}"), "com.intersystems.jdbc.IRISDriver"),
        "tdengine"    => (format!("jdbc:TAOS-RS://{host}:{port}{slash_db}"), "com.taosdata.jdbc.rs.RestfulDriver"),
        "databricks"  => (format!("jdbc:databricks://{host}:{port}"), "com.databricks.client.jdbc.Driver"),
        "xugu"        => (format!("jdbc:xugu://{host}:{port}{slash_db}"), "com.xugu.cloudjdbc.Driver"),
        "iotdb"       => (format!("jdbc:iotdb://{host}:{port}/"), "org.apache.iotdb.jdbc.IoTDBDriver"),
        "kylin"       => (format!("jdbc:kylin://{host}:{port}{slash_db}"), "org.apache.kylin.jdbc.Driver"),
        "sundb"       => (format!("jdbc:sundb://{host}:{port}{slash_db}"), "sunje.sundb.jdbc.SundbDriver"),
        // Access is file-based: `database` is the .accdb/.mdb path.
        "access"      => (format!("jdbc:ucanaccess://{d}"), "net.ucanaccess.jdbc.UcanaccessDriver"),

        other => return Err(DbError::Unsupported(format!("no JDBC mapping for engine '{other}'"))),
    };
    Ok(JdbcTarget { url, driver_class: class.to_string() })
}

fn query_db(d: &str) -> String {
    if d.is_empty() { String::new() } else { format!("?db={d}") }
}

/// Default JDBC driver-class for a profile without building a URL (for UI hints).
pub fn driver_class(profile: &str) -> Option<String> {
    build(profile, "h", 1, "").ok().map(|t| t.driver_class)
}

/// A one-click-downloadable driver JAR (Maven Central), DBeaver-style.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverDownload {
    pub url: String,
    pub file_name: String,
}

/// Build a Maven Central URL + filename for `group:artifact:version` (+ optional
/// classifier). Returns `(url, file_name)`.
fn maven(group: &str, artifact: &str, version: &str, classifier: Option<&str>) -> DriverDownload {
    let gpath = group.replace('.', "/");
    let suffix = classifier.map(|c| format!("-{c}")).unwrap_or_default();
    let file_name = format!("{artifact}-{version}{suffix}.jar");
    DriverDownload {
        url: format!("https://repo1.maven.org/maven2/{gpath}/{artifact}/{version}/{file_name}"),
        file_name,
    }
}

/// Where to fetch the JDBC driver JAR for `profile`, or `None` when the engine's
/// driver is proprietary / not on Maven Central (the user must supply the JAR).
///
/// Only self-contained jars (or vendor "bundle"/"standalone" uber-jars) are
/// listed, so a single download yields a working driver. Versions are pinned and
/// verified to resolve on Maven Central.
pub fn download_spec(profile: &str) -> Option<DriverDownload> {
    Some(match profile {
        "oracle"     => maven("com.oracle.database.jdbc", "ojdbc11", "23.5.0.24.07", None),
        "db2"        => maven("com.ibm.db2", "jcc", "11.5.9.0", None),
        "snowflake"  => maven("net.snowflake", "snowflake-jdbc", "3.19.0", None),
        "trino"      => maven("io.trino", "trino-jdbc", "457", None),
        "hive"       => maven("org.apache.hive", "hive-jdbc", "4.0.1", Some("standalone")),
        "neo4j"      => maven("org.neo4j", "neo4j-jdbc-full-bundle", "6.2.1", None),
        "saphana"    => maven("com.sap.cloud.db.jdbc", "ngdbc", "2.28.8", None),
        "teradata"   => maven("com.teradata.jdbc", "terajdbc", "20.00.00.42", None),
        "vertica"    => maven("com.vertica.jdbc", "vertica-jdbc", "24.3.0-0", None),
        "firebird"   => maven("org.firebirdsql.jdbc", "jaybird", "5.0.6.java11", None),
        "exasol"     => maven("com.exasol", "exasol-jdbc", "24.2.0", None),
        "informix"   => maven("com.ibm.informix", "jdbc", "4.50.10.1", None),
        "iris"       => maven("com.intersystems", "intersystems-jdbc", "3.11.0", None),
        "databricks" => maven("com.databricks", "databricks-jdbc", "2.6.40", None),
        "tdengine"   => maven("com.taosdata.jdbc", "taos-jdbcdriver", "3.4.0", None),
        "kylin"      => maven("org.apache.kylin", "kylin-jdbc", "4.0.4", None),
        "dameng"     => maven("com.dameng", "DmJdbcDriver18", "8.1.3.140", None),
        "kingbase"   => maven("cn.com.kingbase", "kingbase8", "9.0.1", None),
        // Not a clean single-jar download → user supplies the JAR:
        //   cassandra (needs the driver + deps; no published uber-jar),
        //   yashandb/gbase8s/xugu/sundb/bigquery/access (proprietary /
        //   not on Maven Central). h2 is bundled in the plugin.
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oracle_service_name_url() {
        let t = build("oracle", "db.example.com", 1521, "ORCLPDB1").unwrap();
        assert_eq!(t.url, "jdbc:oracle:thin:@//db.example.com:1521/ORCLPDB1");
        assert_eq!(t.driver_class, "oracle.jdbc.OracleDriver");
    }

    #[test]
    fn db2_url() {
        let t = build("db2", "10.0.0.5", 50000, "SAMPLE").unwrap();
        assert_eq!(t.url, "jdbc:db2://10.0.0.5:50000/SAMPLE");
        assert_eq!(t.driver_class, "com.ibm.db2.jcc.DB2Driver");
    }

    #[test]
    fn h2_uses_database_as_full_spec_and_defaults_to_mem() {
        assert_eq!(build("h2", "", 0, "mem:test").unwrap().url, "jdbc:h2:mem:test");
        assert_eq!(build("h2", "", 0, "").unwrap().url, "jdbc:h2:mem:catio");
    }

    #[test]
    fn omits_database_segment_when_empty() {
        assert_eq!(build("hive", "h", 10000, "").unwrap().url, "jdbc:hive2://h:10000");
        assert_eq!(build("vertica", "h", 5433, "").unwrap().url, "jdbc:vertica://h:5433");
    }

    #[test]
    fn snowflake_db_is_a_query_param() {
        assert_eq!(build("snowflake", "acct.snowflakecomputing.com", 443, "WH").unwrap().url,
            "jdbc:snowflake://acct.snowflakecomputing.com:443/?db=WH");
    }

    #[test]
    fn unknown_profile_is_unsupported() {
        let e = build("totally-made-up", "h", 1, "").unwrap_err();
        assert!(matches!(e, DbError::Unsupported(_)));
    }

    #[test]
    fn download_spec_builds_maven_central_urls() {
        let o = download_spec("oracle").unwrap();
        assert_eq!(o.file_name, "ojdbc11-23.5.0.24.07.jar");
        assert_eq!(o.url, "https://repo1.maven.org/maven2/com/oracle/database/jdbc/ojdbc11/23.5.0.24.07/ojdbc11-23.5.0.24.07.jar");
        // classifier (hive standalone uber-jar)
        let h = download_spec("hive").unwrap();
        assert_eq!(h.file_name, "hive-jdbc-4.0.1-standalone.jar");
        assert!(h.url.ends_with("/hive-jdbc/4.0.1/hive-jdbc-4.0.1-standalone.jar"));
    }

    #[test]
    fn proprietary_engines_have_no_download() {
        // 仍无 Maven Central 自包含 jar 的引擎保持手动。
        for p in ["yashandb", "gbase8s", "xugu", "sundb", "bigquery", "access", "cassandra", "h2"] {
            assert!(download_spec(p).is_none(), "{p} should be manual");
        }
    }

    #[test]
    fn chinese_db_downloads_resolve_maven_central() {
        let dm = download_spec("dameng").unwrap();
        assert_eq!(dm.file_name, "DmJdbcDriver18-8.1.3.140.jar");
        assert_eq!(dm.url, "https://repo1.maven.org/maven2/com/dameng/DmJdbcDriver18/8.1.3.140/DmJdbcDriver18-8.1.3.140.jar");
        let kb = download_spec("kingbase").unwrap();
        assert_eq!(kb.file_name, "kingbase8-9.0.1.jar");
        assert_eq!(kb.url, "https://repo1.maven.org/maven2/cn/com/kingbase/kingbase8/9.0.1/kingbase8-9.0.1.jar");
    }

    #[test]
    fn known_engines_all_resolve_a_driver_class() {
        for p in ["oracle","db2","snowflake","hive","trino","cassandra","neo4j","dameng",
                  "saphana","teradata","vertica","firebird","exasol","informix","kingbase",
                  "yashandb","bigquery","iris","tdengine","databricks","xugu","iotdb","kylin","access","h2"] {
            assert!(driver_class(p).is_some(), "missing driver class for {p}");
        }
    }
}
