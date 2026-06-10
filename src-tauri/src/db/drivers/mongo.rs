// adapted from dbx crates/dbx-core/src/db/mongo_driver.rs + mongo_ops.rs, Apache-2.0
use async_trait::async_trait;
use mongodb::{
    bson::{doc, Bson, Document},
    Client,
};
use crate::db::{DbError, DatabaseType};
use crate::db::driver::{ConnectArgs, Driver, TableInfo, TableStructure, ColumnDef, IndexDef, ErRelation};
use crate::db::result::{ColumnInfo, QueryResult, safe_i64_to_json};

pub struct MongoDriver {
    client: Client,
    /// The database selected at connect time (from ConnectArgs.database, or "test").
    default_db: String,
}

impl MongoDriver {
    pub async fn connect(args: &ConnectArgs) -> Result<Self, DbError> {
        // Build the URI: mongodb://[user:pw@]host:port
        let uri = build_uri(args);

        let client = Client::with_uri_str(&uri).await
            .map_err(|e| {
                let msg = e.to_string();
                if is_auth_error(&msg) {
                    DbError::AuthFailed
                } else {
                    DbError::ConnectFailed(msg)
                }
            })?;

        // Validate by pinging admin
        let ping_db = if args.user.is_empty() { "admin" } else {
            args.database.as_deref().unwrap_or("admin")
        };
        client.database(ping_db)
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|e| {
                let msg = e.to_string();
                if is_auth_error(&msg) {
                    DbError::AuthFailed
                } else {
                    DbError::ConnectFailed(msg)
                }
            })?;

        let default_db = args.database.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| "test".into());
        Ok(Self { client, default_db })
    }
}

/// Build a mongodb:// URI from ConnectArgs, including the database path and any
/// advanced options. The options query string is essential for real-world
/// deployments — e.g. `authSource=admin` (auth against a different DB) and
/// `directConnection=true` (skip replica-set discovery, which otherwise resolves
/// internal member hostnames like `mongo:27017` that the client can't reach).
fn build_uri(args: &ConnectArgs) -> String {
    let has_creds = !args.user.is_empty() && args.secret.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
    let authority = if has_creds {
        let user = urlencoded(&args.user);
        let pw = urlencoded(args.secret.as_deref().unwrap_or(""));
        format!("{}:{}@{}:{}", user, pw, args.host, args.port)
    } else {
        format!("{}:{}", args.host, args.port)
    };
    // Always include the path separator; the db name (when given) is the default
    // database (authSource in options can override the auth DB independently).
    let db_path = args.database.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(urlencoded).unwrap_or_default();
    let opts = args.options.as_deref().map(str::trim).filter(|s| !s.is_empty())
        .map(|o| o.trim_start_matches(['?', '&']).to_string());
    // Default a SINGLE-host connection to directConnection=true (matches Compass/
    // DBeaver): without it the driver does replica-set discovery and tries the
    // members' advertised internal hostnames (e.g. mongo:27017), which a desktop
    // client usually can't reach → it hangs on server-selection timeout. Skip when
    // the user already set directConnection or replicaSet, or gave a host list.
    let lower = opts.as_deref().unwrap_or("").to_lowercase();
    let mut params: Vec<String> = Vec::new();
    if let Some(o) = &opts { params.push(o.clone()); }
    if !args.host.contains(',') && !lower.contains("directconnection") && !lower.contains("replicaset") {
        params.push("directConnection=true".to_string());
    }
    let mut uri = format!("mongodb://{authority}/{db_path}");
    if !params.is_empty() {
        uri.push('?');
        uri.push_str(&params.join("&"));
    }
    uri
}

/// Minimal percent-encoding for URI credentials (encode @, /, :, ? etc.).
fn urlencoded(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(c),
            _ => {
                let mut buf = [0u8; 4];
                let encoded = c.encode_utf8(&mut buf);
                for b in encoded.bytes() {
                    out.push('%');
                    out.push_str(&format!("{:02X}", b));
                }
            }
        }
    }
    out
}

fn is_auth_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("authentication failed")
        || lower.contains("not authorized")
        || lower.contains("auth error")
        || lower.contains("invalid credentials")
}

/// Convert a BSON value to serde_json::Value cleanly (no $oid wrappers).
/// Adapted from dbx mongo_driver.rs bson_to_json.
fn bson_to_json(bson: &Bson) -> serde_json::Value {
    match bson {
        Bson::Double(v) => serde_json::Number::from_f64(*v)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Bson::String(v) => serde_json::Value::String(v.clone()),
        Bson::Boolean(v) => serde_json::Value::Bool(*v),
        Bson::Null | Bson::Undefined => serde_json::Value::Null,
        Bson::Int32(v) => serde_json::Value::Number((*v).into()),
        Bson::Int64(v) => safe_i64_to_json(*v),
        Bson::ObjectId(oid) => serde_json::Value::String(oid.to_hex()),
        Bson::DateTime(dt) => serde_json::Value::String(dt.to_string()),
        Bson::Array(arr) => serde_json::Value::Array(arr.iter().map(bson_to_json).collect()),
        Bson::Document(doc) => {
            let mut map = serde_json::Map::new();
            for (k, v) in doc {
                map.insert(k.clone(), bson_to_json(v));
            }
            serde_json::Value::Object(map)
        }
        Bson::Binary(b) => {
            // hex-encode binary
            let hex: String = b.bytes.iter().map(|byte| format!("{:02x}", byte)).collect();
            serde_json::Value::String(format!("0x{}", hex))
        }
        Bson::Decimal128(d) => serde_json::Value::String(d.to_string()),
        Bson::Timestamp(ts) => serde_json::Value::String(format!("Timestamp({},{})", ts.time, ts.increment)),
        Bson::RegularExpression(re) => serde_json::Value::String(format!("/{}/{}", re.pattern, re.options)),
        Bson::JavaScriptCode(s) => serde_json::Value::String(s.clone()),
        Bson::Symbol(s) => serde_json::Value::String(s.clone()),
        // Anything else: use Display
        _ => serde_json::Value::String(format!("{}", bson)),
    }
}

/// Infer the BSON type name (for table_structure column type).
fn bson_type_name(bson: &Bson) -> &'static str {
    match bson {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Boolean(_) => "bool",
        Bson::Null | Bson::Undefined => "null",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Binary(_) => "binary",
        Bson::Decimal128(_) => "decimal128",
        Bson::Timestamp(_) => "timestamp",
        _ => "mixed",
    }
}

/// Flatten sampled documents into a pseudo-table QueryResult: columns are the
/// field-name union (`_id` first), each row is aligned to that column order.
/// Truncates to `max_rows` and reports whether more were fetched.
fn docs_to_result(mut docs: Vec<Document>, max_rows: u32) -> QueryResult {
    let truncated = docs.len() > max_rows as usize;
    if truncated {
        docs.truncate(max_rows as usize);
    }
    let mut col_names: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // `_id` always first when present.
    if docs.iter().any(|d| d.contains_key("_id")) {
        col_names.push("_id".to_string());
        seen.insert("_id".to_string());
    }
    for doc in &docs {
        for key in doc.keys() {
            if seen.insert(key.clone()) {
                col_names.push(key.clone());
            }
        }
    }
    let columns: Vec<ColumnInfo> = col_names.iter().map(|name| ColumnInfo {
        name: name.clone(),
        type_name: "mixed".into(),
        pk: name == "_id",
    }).collect();
    let rows: Vec<Vec<serde_json::Value>> = docs.iter().map(|doc| {
        col_names.iter().map(|col| match doc.get(col) {
            Some(bson) => bson_to_json(bson),
            None => serde_json::Value::Null,
        }).collect()
    }).collect();
    QueryResult { columns, rows, rows_affected: None, truncated }
}

#[async_trait]
impl Driver for MongoDriver {
    fn db_type(&self) -> DatabaseType { DatabaseType::Mongodb }

    async fn test(&self) -> Result<String, DbError> {
        let db = self.client.database(&self.default_db);
        let result = db.run_command(doc! { "buildInfo": 1 }).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let version = result.get_str("version").unwrap_or("unknown").to_string();
        Ok(version)
    }

    async fn list_schemas(&self) -> Result<Vec<String>, DbError> {
        self.client.list_database_names().await
            .map_err(|e| DbError::QueryFailed(e.to_string()))
    }

    async fn list_tables(&self, schema: &str) -> Result<Vec<TableInfo>, DbError> {
        let db = self.client.database(schema);
        let names = db.list_collection_names().await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let tables = names.into_iter().map(|name| TableInfo {
            name,
            kind: "table".into(),
            rows_estimate: None,
        }).collect();
        Ok(tables)
    }

    /// mongo shell 风格查询控制台(语法行为照 dbx):输入由 mongo_shell::parse
    /// 解析为结构化命令后用 mongodb crate 执行。database 取连接配置的 default_db。
    async fn query(&self, sql: &str, max_rows: u32) -> Result<QueryResult, DbError> {
        use futures_util::TryStreamExt;
        use crate::db::drivers::mongo_shell::{self, MongoCommand};

        let cmd = mongo_shell::parse(sql).map_err(DbError::QueryFailed)?;
        let db = self.client.database(&self.default_db);
        let map_err = |e: mongodb::error::Error| DbError::QueryFailed(e.to_string());

        // 写命令的统一回执:空表格 + rows_affected。
        fn affected(n: u64) -> QueryResult {
            QueryResult { columns: vec![], rows: vec![], rows_affected: Some(n), truncated: false }
        }

        match cmd {
            MongoCommand::Find { collection, filter, sort, skip, limit } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let filter = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                // 多取 1 条用于 truncated 检测;用户 limit 更小时以用户为准。
                let cap = (max_rows as i64) + 1;
                let fetch = limit.map(|l| l.min(cap)).unwrap_or(cap);
                let mut find = coll.find(filter).limit(fetch);
                if let Some(s) = &sort {
                    find = find.sort(mongo_shell::json_to_doc(s).map_err(DbError::QueryFailed)?);
                }
                if let Some(sk) = skip {
                    find = find.skip(sk);
                }
                let mut cursor = find.await.map_err(map_err)?;
                let mut docs: Vec<Document> = Vec::new();
                while let Some(d) = cursor.try_next().await.map_err(map_err)? {
                    docs.push(d);
                }
                Ok(docs_to_result(docs, max_rows))
            }
            MongoCommand::Count { collection, filter } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let filter = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let n = coll.count_documents(filter).await.map_err(map_err)?;
                Ok(QueryResult {
                    columns: vec![ColumnInfo { name: "count".into(), type_name: "int64".into(), pk: false }],
                    rows: vec![vec![safe_i64_to_json(n as i64)]],
                    rows_affected: None,
                    truncated: false,
                })
            }
            MongoCommand::Aggregate { collection, pipeline } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let stages: Vec<Document> = pipeline
                    .as_array()
                    .map(|arr| arr.iter().map(mongo_shell::json_to_doc).collect::<Result<Vec<_>, _>>())
                    .unwrap_or_else(|| Ok(vec![]))
                    .map_err(DbError::QueryFailed)?;
                let mut cursor = coll.aggregate(stages).await.map_err(map_err)?;
                let mut docs: Vec<Document> = Vec::new();
                while let Some(d) = cursor.try_next().await.map_err(map_err)? {
                    docs.push(d);
                    if docs.len() > max_rows as usize { break; }
                }
                Ok(docs_to_result(docs, max_rows))
            }
            MongoCommand::GetIndexes { collection } => {
                // 走 listIndexes 命令取 firstBatch,避免 IndexModel 的手工展开。
                let res = db.run_command(doc! { "listIndexes": &collection }).await.map_err(map_err)?;
                let docs: Vec<Document> = res
                    .get_document("cursor").ok()
                    .and_then(|c| c.get_array("firstBatch").ok())
                    .map(|arr| arr.iter().filter_map(|b| b.as_document().cloned()).collect())
                    .unwrap_or_default();
                Ok(docs_to_result(docs, max_rows))
            }
            MongoCommand::InsertOne { collection, doc: d } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let bd = mongo_shell::json_to_doc(&d).map_err(DbError::QueryFailed)?;
                coll.insert_one(bd).await.map_err(map_err)?;
                Ok(affected(1))
            }
            MongoCommand::InsertMany { collection, docs } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let bds: Vec<Document> = docs
                    .as_array()
                    .map(|arr| arr.iter().map(mongo_shell::json_to_doc).collect::<Result<Vec<_>, _>>())
                    .unwrap_or_else(|| Ok(vec![]))
                    .map_err(DbError::QueryFailed)?;
                let n = bds.len() as u64;
                coll.insert_many(bds).await.map_err(map_err)?;
                Ok(affected(n))
            }
            MongoCommand::UpdateOne { collection, filter, update } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let f = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let u = mongo_shell::json_to_doc(&update).map_err(DbError::QueryFailed)?;
                let r = coll.update_one(f, u).await.map_err(map_err)?;
                Ok(affected(r.modified_count))
            }
            MongoCommand::UpdateMany { collection, filter, update } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let f = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let u = mongo_shell::json_to_doc(&update).map_err(DbError::QueryFailed)?;
                let r = coll.update_many(f, u).await.map_err(map_err)?;
                Ok(affected(r.modified_count))
            }
            MongoCommand::DeleteOne { collection, filter } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let f = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let r = coll.delete_one(f).await.map_err(map_err)?;
                Ok(affected(r.deleted_count))
            }
            MongoCommand::DeleteMany { collection, filter } => {
                let coll: mongodb::Collection<Document> = db.collection(&collection);
                let f = mongo_shell::json_filter_to_doc(&filter).map_err(DbError::QueryFailed)?;
                let r = coll.delete_many(f).await.map_err(map_err)?;
                Ok(affected(r.deleted_count))
            }
        }
    }

    /// Native collection-data preview: `schema` is the database, `table` the
    /// collection, paginated via skip/limit (no SQL). This is what powers the
    /// data grid for MongoDB — the default SQL path can't run against Mongo.
    async fn table_data(&self, schema: Option<&str>, table: &str, limit: u32, offset: u32)
        -> Result<QueryResult, DbError> {
        use futures_util::TryStreamExt;
        let dbname = schema.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(self.default_db.as_str());
        let db = self.client.database(dbname);
        let coll: mongodb::Collection<Document> = db.collection(table);
        // +1 to detect truncation; skip applies the page offset.
        let fetch = (limit as i64) + 1;
        let mut cursor = coll.find(doc! {}).skip(offset as u64).limit(fetch).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;
        let mut docs: Vec<Document> = Vec::new();
        while let Some(doc) = cursor.try_next().await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
        {
            docs.push(doc);
        }
        Ok(docs_to_result(docs, limit))
    }

    async fn table_structure(&self, schema: &str, table: &str) -> Result<TableStructure, DbError> {
        use futures_util::TryStreamExt;

        let db = self.client.database(schema);
        let coll: mongodb::Collection<Document> = db.collection(table);

        // Sample up to 50 documents to infer schema
        let mut cursor = coll.find(doc! {}).limit(50).await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let mut docs: Vec<Document> = Vec::new();
        while let Some(doc) = cursor.try_next().await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
        {
            docs.push(doc);
        }

        // Infer columns: first-seen field order, _id first; type from first non-null occurrence
        let mut col_names: Vec<String> = Vec::new();
        let mut col_types: std::collections::HashMap<String, &'static str> = std::collections::HashMap::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for doc in &docs {
            if doc.contains_key("_id") && seen.insert("_id".to_string()) {
                col_names.push("_id".to_string());
            }
            break;
        }
        seen.insert("_id".to_string());

        for doc in &docs {
            for (key, val) in doc {
                if seen.insert(key.clone()) {
                    col_names.push(key.clone());
                }
                // Update type if not yet set or was "null"
                let entry = col_types.entry(key.clone()).or_insert("null");
                if *entry == "null" {
                    *entry = bson_type_name(val);
                }
            }
        }

        let columns: Vec<ColumnDef> = col_names.iter().map(|name| {
            let type_name = col_types.get(name).copied().unwrap_or("mixed");
            let key = if name == "_id" { "PK" } else { "" };
            ColumnDef {
                name: name.clone(),
                type_name: type_name.to_string(),
                nullable: name != "_id",
                default: None,
                key: key.into(),
            }
        }).collect();

        // Indexes: list_indexes() on the collection
        let mut idx_cursor = coll.list_indexes().await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?;

        let mut indexes: Vec<IndexDef> = Vec::new();
        while let Some(index_model) = idx_cursor.try_next().await
            .map_err(|e| DbError::QueryFailed(e.to_string()))?
        {
            // index_model is IndexModel; key is a Document of field -> direction
            let idx_name = index_model.options
                .as_ref()
                .and_then(|o| o.name.as_deref())
                .unwrap_or("unknown")
                .to_string();
            let key_doc = &index_model.keys;
            let key_fields: String = key_doc.iter()
                .map(|(k, _)| k.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let unique = index_model.options
                .as_ref()
                .and_then(|o| o.unique)
                .unwrap_or(false);
            indexes.push(IndexDef {
                name: idx_name,
                columns: key_fields,
                unique,
                method: "btree".into(),
            });
        }

        Ok(TableStructure {
            columns,
            indexes,
            fks: vec![],
        })
    }

    async fn er_relations(&self, _schema: &str) -> Result<Vec<ErRelation>, DbError> {
        Ok(vec![])
    }
}

#[cfg(test)]
mod uri_tests {
    use super::build_uri;
    use crate::db::driver::ConnectArgs;
    use crate::db::DatabaseType;

    fn args(db: Option<&str>, opts: Option<&str>, creds: bool) -> ConnectArgs {
        ConnectArgs {
            db_type: DatabaseType::Mongodb,
            host: "192.168.10.253".into(),
            port: 27017,
            user: if creds { "myusername".into() } else { String::new() },
            secret: if creds { Some("12345678".into()) } else { None },
            database: db.map(str::to_string),
            driver_profile: None,
            options: opts.map(str::to_string),
        }
    }

    #[test]
    fn builds_uri_with_db_and_advanced_options() {
        // the exact real-world case: auth against admin + direct connection
        let a = args(Some("fastgpt"), Some("authSource=admin&directConnection=true"), true);
        assert_eq!(
            build_uri(&a),
            "mongodb://myusername:12345678@192.168.10.253:27017/fastgpt?authSource=admin&directConnection=true"
        );
    }

    #[test]
    fn options_without_db_use_empty_path() {
        let a = args(None, Some("directConnection=true"), false);
        assert_eq!(build_uri(&a), "mongodb://192.168.10.253:27017/?directConnection=true");
    }

    #[test]
    fn strips_leading_separator_and_appends_direct_default() {
        // options without directConnection/replicaSet → single-host default appended.
        let a = args(Some("db"), Some("?retryWrites=false"), false);
        assert_eq!(build_uri(&a), "mongodb://192.168.10.253:27017/db?retryWrites=false&directConnection=true");
    }

    #[test]
    fn single_host_defaults_to_direct_connection() {
        // No options + single host → directConnection=true so the client doesn't
        // hang on replica-set discovery (the real bug the user hit).
        let a = args(None, None, false);
        assert_eq!(build_uri(&a), "mongodb://192.168.10.253:27017/?directConnection=true");
    }

    #[test]
    fn does_not_add_direct_when_replica_set_requested() {
        // replicaSet present → user wants discovery → leave it alone.
        let a = args(Some("app"), Some("replicaSet=rs0"), false);
        assert_eq!(build_uri(&a), "mongodb://192.168.10.253:27017/app?replicaSet=rs0");
    }
}

#[cfg(test)]
mod result_tests {
    use super::docs_to_result;
    use mongodb::bson::doc;
    use serde_json::{json, Value};

    #[test]
    fn columns_are_field_union_with_id_first_and_pk() {
        let docs = vec![
            doc! { "_id": 1, "name": "a" },
            doc! { "_id": 2, "name": "b", "age": 30 },
        ];
        let r = docs_to_result(docs, 100);
        let cols: Vec<String> = r.columns.iter().map(|c| c.name.clone()).collect();
        assert_eq!(cols, vec!["_id", "name", "age"]);
        assert!(r.columns[0].pk, "_id should be the pk column");
        assert_eq!(r.rows.len(), 2);
        // sparse field: row 0 has no age → null; row 1 has 30
        assert_eq!(r.rows[0][2], Value::Null);
        assert_eq!(r.rows[1][2], json!(30));
    }

    #[test]
    fn truncates_to_max_rows_and_flags() {
        let docs = vec![doc! { "_id": 1 }, doc! { "_id": 2 }, doc! { "_id": 3 }];
        let r = docs_to_result(docs, 2);
        assert_eq!(r.rows.len(), 2);
        assert!(r.truncated);
    }

    #[test]
    fn empty_collection_yields_no_columns() {
        let r = docs_to_result(vec![], 100);
        assert!(r.columns.is_empty());
        assert!(r.rows.is_empty());
        assert!(!r.truncated);
    }
}
