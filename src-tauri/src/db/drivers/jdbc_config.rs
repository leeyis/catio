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
    fn known_engines_all_resolve_a_driver_class() {
        for p in ["oracle","db2","snowflake","hive","trino","cassandra","neo4j","dameng",
                  "saphana","teradata","vertica","firebird","exasol","informix","kingbase",
                  "yashandb","bigquery","iris","tdengine","databricks","xugu","iotdb","kylin","access","h2"] {
            assert!(driver_class(p).is_some(), "missing driver class for {p}");
        }
    }
}
