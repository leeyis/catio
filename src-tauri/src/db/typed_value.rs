//! Type-aware SQL literals. A hex-looking string is text unless the result/edit metadata says binary.
use std::collections::HashSet;
use serde_json::Value;
use crate::db::{DatabaseType, DbError, driver::EditRequest, result::QueryResult};
use crate::db::dialect::{quote_ident, qualified_table};

pub fn binary_hex(value: &Value) -> Result<&str, DbError> {
    let text = value.as_str().ok_or_else(|| DbError::QueryFailed("Binary values must be 0x-prefixed hexadecimal text".into()))?;
    let hex = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X"))
        .ok_or_else(|| DbError::QueryFailed("Binary values must start with 0x".into()))?;
    if hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(DbError::QueryFailed("Binary values require an even number of hexadecimal digits".into()));
    }
    Ok(hex)
}

pub fn sql_value(db: DatabaseType, value: &Value, binary: bool) -> Result<String, DbError> {
    if !binary || value.is_null() { return Ok(crate::db::dml::value_to_sql_for(db, value)); }
    let hex = binary_hex(value)?;
    Ok(match db {
        DatabaseType::Postgres => format!("decode('{hex}', 'hex')"),
        DatabaseType::Sqlserver => format!("0x{hex}"),
        DatabaseType::Duckdb => format!("from_hex('{hex}')"),
        DatabaseType::Clickhouse => format!("unhex('{hex}')"),
        DatabaseType::Mysql | DatabaseType::Sqlite | DatabaseType::Rqlite | DatabaseType::Jdbc => format!("X'{hex}'"),
        _ => return Err(DbError::Unsupported("SQL binary literals are unavailable for this engine".into())),
    })
}

pub fn binary_type(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    let base = lower.split(['(', ' ']).next().unwrap_or("");
    matches!(base, "bytea" | "blob" | "tinyblob" | "mediumblob" | "longblob" | "binary" | "varbinary" |
        "longvarbinary" | "binaryvarying" | "largebinary" | "fixedsizebinary" | "bigvarbin" | "bigbinary" | "image" | "raw")
        || lower.starts_with("binary varying")
}

/// Strictly typed engines can use column metadata; SQLite must mark each actual ValueRef instead.
pub fn mark_binary_columns(mut result: QueryResult) -> QueryResult {
    result.binary_cells = result.rows.iter().enumerate().flat_map(|(r, row)| {
        let columns = &result.columns;
        row.iter().enumerate().filter_map(move |(c, v)|
            (!v.is_null() && columns.get(c).is_some_and(|col| binary_type(&col.type_name))).then_some([r,c]))
    }).collect();
    result
}

fn validate_columns(names: &[String], values: &[(String, Value)]) -> Result<HashSet<String>, DbError> {
    let mut seen = HashSet::new();
    for name in names {
        if !seen.insert(name.clone()) || !values.iter().any(|(column, _)| column == name) {
            return Err(DbError::QueryFailed("Binary column metadata must reference each supplied column at most once".into()));
        }
    }
    Ok(seen)
}

pub fn edit_sql(db: DatabaseType, req: &EditRequest) -> Result<String, DbError> {
    let binary = validate_columns(&req.binary_columns, &req.cells)?;
    let binary_pk = validate_columns(req.binary_pk_columns.as_deref().unwrap_or(&[]), &req.pk)?;
    let target = qualified_table(db, true, req.schema.as_deref(), &req.table);
    let values = req.cells.iter().map(|(name, value)| sql_value(db, value, binary.contains(name)))
        .collect::<Result<Vec<_>,_>>()?;
    let predicates = req.pk.iter().map(|(name,value)| Ok(format!("{} = {}", quote_ident(db,name),
        sql_value(db,value,binary_pk.contains(name))?))).collect::<Result<Vec<_>,DbError>>()?.join(" AND ");
    Ok(match req.kind.as_str() {
        "insert" => format!("INSERT INTO {target} ({}) VALUES ({})", req.cells.iter().map(|(c,_)|quote_ident(db,c)).collect::<Vec<_>>().join(", "), values.join(", ")),
        "update" => format!("UPDATE {target} SET {} WHERE {predicates}", req.cells.iter().zip(values).map(|((c,_),v)|format!("{} = {v}",quote_ident(db,c))).collect::<Vec<_>>().join(", ")),
        "delete" => format!("DELETE FROM {target} WHERE {predicates}"),
        _ => return Err(DbError::Unsupported("Unknown edit operation".into())),
    })
}

/// PostgreSQL bytea_output can be hex or escape, independently of the wire encoding.
pub fn pg_binary(text: &str) -> Result<Value,DbError> {
    let invalid=||DbError::QueryFailed("Invalid PostgreSQL bytea representation".into());
    let bytes=if let Some(hex)=text.strip_prefix("\\x") {
        if hex.len()%2!=0 || !hex.bytes().all(|b|b.is_ascii_hexdigit()) { return Err(invalid()); }
        hex.as_bytes().chunks_exact(2).map(|pair| {
            let nibble=|b:u8|if b.is_ascii_digit(){b-b'0'}else{b.to_ascii_lowercase()-b'a'+10};
            nibble(pair[0])*16+nibble(pair[1])
        }).collect::<Vec<_>>()
    } else {
        let input=text.as_bytes();let mut output=Vec::new();let mut i=0;
        while i<input.len() {
            if input[i]!=b'\\' { output.push(input[i]); i+=1; }
            else if input.get(i+1)==Some(&b'\\') { output.push(b'\\');i+=2; }
            else if i+3<input.len() && input[i+1..i+4].iter().all(|b|(b'0'..=b'7').contains(b)) {
                let byte=u16::from(input[i+1]-b'0')*64+u16::from(input[i+2]-b'0')*8+u16::from(input[i+3]-b'0');
                output.push(u8::try_from(byte).map_err(|_|invalid())?);i+=4;
            } else { return Err(invalid()); }
        }
        output
    };
    Ok(crate::db::result::binary_to_json(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn literal_is_explicit_and_validated() {
        assert_eq!(sql_value(DatabaseType::Sqlite,&json!("0x00ff"),false).unwrap(),"'0x00ff'");
        assert_eq!(sql_value(DatabaseType::Sqlite,&json!("0x00ff"),true).unwrap(),"X'00ff'");
        assert_eq!(sql_value(DatabaseType::Postgres,&json!("0x"),true).unwrap(),"decode('', 'hex')");
        assert_eq!(sql_value(DatabaseType::Sqlserver,&json!("0x"),true).unwrap(),"0x");
        assert_eq!(sql_value(DatabaseType::Duckdb,&json!("0xFF"),true).unwrap(),"from_hex('FF')");
        assert_eq!(sql_value(DatabaseType::Jdbc,&Value::Null,true).unwrap(),"NULL");
        for v in [json!("0xf"),json!("0x0';DROP"),json!("abcd"),json!({"hex":"ff"})] { assert!(sql_value(DatabaseType::Sqlite,&v,true).is_err()); }
    }
    #[test]
    fn postgres_binary_formats_are_equivalent() {
        assert_eq!(pg_binary(r"\x00ff5c41").unwrap(),json!("0x00ff5c41"));
        assert_eq!(pg_binary(r"\000\377\\A").unwrap(),json!("0x00ff5c41"));
        assert_eq!(pg_binary("").unwrap(),json!("0x"));
        for value in [r"\x0",r"\777",r"\bad"] { assert!(pg_binary(value).is_err()); }
    }
    #[test]
    fn json_shapes_are_never_type_tags() {
        let value=json!({"$catioBinary":{"hex":"00ff"}});
        assert_eq!(sql_value(DatabaseType::Sqlite,&value,false).unwrap(),"'{\"$catioBinary\":{\"hex\":\"00ff\"}}'");
    }
}
