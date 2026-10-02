//! Shared desktop/Web write orchestration. No transport, AppHandle or user filesystem paths.
//! Never construct transactions by sending BEGIN/COMMIT through a pooled Driver::query.
use std::io::{BufRead, BufReader, BufWriter, Seek, SeekFrom, Write};
use crate::db::{DatabaseType, DbError, driver::{Driver, EditRequest, StatementBatch}, dialect::qualified_table};
use crate::db::table_import::{self as ti, ImportColumnMapping};
use crate::db::transfer::{self as tr, TransferColumnMapping, TransferMode};
use crate::db::commands::{ImportPreview, ImportSummary, TransferSummary};

fn sql_writer(driver: &dyn Driver) -> Result<(), DbError> {
    if !driver.capabilities().writable {
        return Err(DbError::Unsupported("read-only engine".into()));
    }
    if matches!(driver.db_type(), DatabaseType::Redis | DatabaseType::Mongodb | DatabaseType::Elasticsearch) {
        return Err(DbError::Unsupported("Use the native document/key editor for this engine".into()));
    }
    Ok(())
}

pub async fn apply_edits(driver: &dyn Driver, edits: &[EditRequest]) -> Result<u64, DbError> {
    sql_writer(driver)?;
    // Validate EVERY request before the first write. An invalid later request must not
    // leave earlier rows modified, even for a non-transactional engine.
    let statements = edits.iter().map(|r| crate::db::commands::build_sql(driver.db_type(), r))
        .collect::<Result<Vec<_>, _>>()?;
    if statements.is_empty() { return Ok(0); }
    if statements.len() == 1 { return Ok(driver.query(&statements[0], 0).await?.rows_affected.unwrap_or(0)); }
    if driver.capabilities().transactions {
        let mut checked = std::collections::HashSet::new();
        for edit in edits {
            if checked.insert((edit.schema.as_deref(), edit.table.as_str())) {
                driver.ensure_atomic_table(edit.schema.as_deref(), &edit.table).await?;
            }
        }
        driver.exec_batch(&statements).await
    } else {
        Err(DbError::Unsupported("This engine cannot atomically save multiple row edits; save one edit at a time".into()))
    }
}

pub fn import_preview(file_name: &str, bytes: &[u8]) -> Result<ImportPreview, DbError> {
    ti::check_import_size(bytes.len()).map_err(DbError::QueryFailed)?;
    let kind = ti::import_file_kind(file_name).map_err(DbError::QueryFailed)?;
    let parsed = ti::parse_import_bytes(kind, bytes, ti::DEFAULT_PREVIEW_LIMIT).map_err(DbError::QueryFailed)?;
    Ok(ImportPreview {
        binary_cells: parsed.binary_cells,
        file_name: file_name.rsplit(['/', '\\']).next().unwrap_or(file_name).to_string(),
        file_type: kind.label().to_string(), size_bytes: bytes.len() as u64,
        truncated: parsed.rows.len() < parsed.total_rows,
        columns: parsed.columns, rows: parsed.rows, total_rows: parsed.total_rows,
    })
}

/// Replacement uses DELETE, not MySQL TRUNCATE (which implicitly commits). Identity
/// counters are intentionally retained. Unsupported transactional engines fail BEFORE
/// modifying the target, not after a misleading promise of rollback.
fn replacement_sql(driver: &dyn Driver, schema: Option<&str>, table: &str) -> Result<String, DbError> {
    if !driver.capabilities().transactions {
        return Err(DbError::Unsupported("Atomic replacement is unavailable for this engine; use append or a native backup/restore workflow".into()));
    }
    Ok(format!("DELETE FROM {}", qualified_table(driver.db_type(), true, schema, table)))
}

#[allow(clippy::too_many_arguments)]
pub async fn import_bytes(
    driver: &dyn Driver, schema: Option<&str>, table: &str, file_name: &str, bytes: &[u8],
    mappings: &[ImportColumnMapping], mode: &str, batch_size: usize, allow_destructive: bool,
) -> Result<ImportSummary, DbError> {
    sql_writer(driver)?;
    if driver.capabilities().transactions { driver.ensure_atomic_table(schema, table).await?; }
    if !matches!(mode, "append" | "truncate") {
        return Err(DbError::QueryFailed("Import mode must be append or truncate".into()));
    }
    if mode == "truncate" && !allow_destructive {
        return Err(DbError::QueryFailed("Replacing table data requires explicit confirmation".into()));
    }
    ti::check_import_size(bytes.len()).map_err(DbError::QueryFailed)?;
    let kind = ti::import_file_kind(file_name).map_err(DbError::QueryFailed)?;
    let parsed = ti::parse_import_bytes(kind, bytes, usize::MAX).map_err(DbError::QueryFailed)?;
    let total_rows = parsed.total_rows;
    let schema = schema.filter(|s| !s.trim().is_empty());
    let batches = ti::build_import_insert_batches(driver.db_type(), true, schema, table, &parsed,
        mappings, batch_size.clamp(1, 1000)).map_err(DbError::QueryFailed)?;
    // Parse and map first, then compose the replacement in the same physical transaction.
    let mut statements = Vec::with_capacity(batches.len() + 1);
    if mode == "truncate" { statements.push(replacement_sql(driver, schema, table)?); }
    statements.extend(batches.iter().map(|b| b.sql.clone()));
    if driver.capabilities().transactions {
        driver.exec_batch(&statements).await?;
    } else {
        let mut imported = 0;
        for batch in batches {
            driver.query(&batch.sql, 0).await.map_err(|e| DbError::QueryFailed(format!(
                "Import stopped after {imported} committed rows (non-transactional engine): {e}")))?;
            imported += batch.row_count;
        }
    }
    Ok(ImportSummary { rows_imported: total_rows, total_rows })
}

/// Prepare the entire source into a secure, auto-deleted spool BEFORE any target write.
/// This handles same-connection copies without deadlocking single-client drivers, bounds
/// memory, and keeps source read failures/disk-full from destroying the original target.
/// The source must be stable during preparation; this is not a cross-database snapshot.
#[allow(clippy::too_many_arguments)]
pub async fn transfer_table(
    source: &dyn Driver, source_schema: Option<&str>, source_table: &str,
    target: &dyn Driver, target_schema: Option<&str>, target_table: &str,
    mappings: &[TransferColumnMapping], mode: TransferMode, upsert_keys: &[String],
    batch_size: usize, allow_destructive: bool,
    progress: &(dyn Fn(u64, bool) + Send + Sync),
) -> Result<TransferSummary, DbError> {
    if matches!(source.db_type(), DatabaseType::Redis | DatabaseType::Mongodb | DatabaseType::Elasticsearch) {
        return Err(DbError::Unsupported("SQL table transfer requires a relational source".into()));
    }
    sql_writer(target)?;
    if target.capabilities().transactions { target.ensure_atomic_table(target_schema, target_table).await?; }
    let targets: Vec<_> = mappings.iter().filter(|m| !m.target_column.trim().is_empty())
        .map(|m| m.target_column.clone()).collect();
    tr::check_transfer_preconditions(mode, target.db_type(), &targets, upsert_keys, allow_destructive)
        .map_err(DbError::QueryFailed)?;
    let replacement = if mode == TransferMode::Overwrite {
        Some(replacement_sql(target, target_schema, target_table)?)
    } else { None };
    let batch = batch_size.clamp(1, 1000) as u32;
    let mut spool = tempfile::tempfile().map_err(|e| DbError::Io(e.to_string()))?;
    let (mut offset, mut transferred, mut written) = (0u32, 0usize, 0u64);
    const MAX_SPOOL_BYTES: u64 = 1024 * 1024 * 1024;
    // Stable PK order where available. Keyless source tables still require a quiescent
    // source; do not claim a consistent snapshot under concurrent source modifications.
    let structure = source.table_structure(source_schema.unwrap_or(""), source_table).await?;
    let order = structure.columns.iter().filter(|c| c.key == "PK")
        .map(|c| crate::db::dialect::quote_ident(source.db_type(), &c.name)).collect::<Vec<_>>().join(", ");
    let has_locator = source.table_has_row_identity(source_schema, source_table).await?;
    let mut expected_columns: Option<Vec<String>> = None;
    let mut mapped = Vec::new();
    {
        let mut out = BufWriter::new(&mut spool);
        if let Some(sql) = replacement { written += write_record(&mut out, &sql, MAX_SPOOL_BYTES - written)?; }
        loop {
            let result = source.table_query(source_schema, source_table, None,
                (!order.is_empty()).then_some(order.as_str()), batch, offset).await?;
            let locator = if has_locator { result.columns.iter().position(|c| c.name == "__ctid") } else { None };
            let columns: Vec<_> = result.columns.iter().enumerate().filter(|(i, _)| Some(*i) != locator)
                .map(|(_, c)| c.name.clone()).collect();
            if let Some(expected) = &expected_columns {
                if expected != &columns { return Err(DbError::QueryFailed("Source structure changed during transfer preparation".into())); }
            } else {
                mapped = tr::resolve_transfer_mapping(&columns, mappings).map_err(DbError::QueryFailed)?;
                expected_columns = Some(columns);
            }
            let count = result.rows.len();
            let binary_cells: Vec<_> = result.binary_cells.into_iter().filter_map(|[r,c]| {
                if locator==Some(c) { None } else { Some([r,c-usize::from(locator.is_some_and(|i|i<c))]) }
            }).collect();
            let rows = result.rows.into_iter().map(|row| row.into_iter().enumerate()
                .filter(|(i, _)| Some(*i) != locator).map(|(_, value)| value).collect::<Vec<_>>()).collect::<Vec<_>>();
            // Scalar bytes are now tagged. Nested binary needs a recursive typed serializer;
            // never reinterpret JSON text just because it happens to contain a hex string.
            if result.columns.iter().any(|c| {
                let ty=c.type_name.to_ascii_lowercase();
                (ty.contains("list") || ty.contains("struct") || ty.contains("map")) && (ty.contains("binary") || ty.contains("blob"))
            }) { return Err(DbError::Unsupported("Nested binary collection transfer requires a recursive typed serializer".into())); }
            if count > 0 {
                let sql = tr::build_transfer_write_sql_typed(mode, target.db_type(), true, target_schema,
                    target_table, &mapped, &rows, upsert_keys, &binary_cells)?;
                written += write_record(&mut out, &sql, MAX_SPOOL_BYTES - written)?;
                transferred += count;
            }
            if !result.truncated { break; }
            if count == 0 { return Err(DbError::QueryFailed("Source returned an empty page with more rows indicated".into())); }
            offset = offset.checked_add(count as u32).ok_or_else(|| DbError::QueryFailed("Transfer offset overflow".into()))?;
        }
        out.flush().map_err(|e| DbError::Io(e.to_string()))?;
    }
    spool.seek(SeekFrom::Start(0)).map_err(|e| DbError::Io(e.to_string()))?;
    let statements: StatementBatch = Box::new(BufReader::new(spool).lines().map(|line| {
        let line = line.map_err(|e| DbError::Io(e.to_string()))?;
        serde_json::from_str::<String>(&line).map_err(|e| DbError::Io(e.to_string()))
    }));
    progress(0, false); // no rows are reported committed before the transaction commits
    if target.capabilities().transactions {
        target.exec_statement_batch(statements).await?;
    } else {
        let mut batches = 0;
        for sql in statements {
            target.query(&sql?, 0).await.map_err(|e| DbError::QueryFailed(format!(
                "Transfer stopped after {batches} committed batches (non-transactional engine): {e}")))?;
            batches += 1;
        }
    }
    progress(transferred as u64, true);
    Ok(TransferSummary { rows_transferred: transferred })
}

fn write_record(writer: &mut impl Write, sql: &str, remaining: u64) -> Result<u64, DbError> {
    // Account for UTF-8, JSON escaping and the record delimiter, not just raw SQL length.
    let encoded = serde_json::to_vec(sql).map_err(|e| DbError::Io(e.to_string()))?;
    let bytes = encoded.len() as u64 + 1;
    if bytes > remaining {
        return Err(DbError::Unsupported("Transfer staging exceeds 1 GiB; narrow the source or use a native bulk-transfer tool. Target unchanged".into()));
    }
    writer.write_all(&encoded).map_err(|e| DbError::Io(e.to_string()))?;
    writer.write_all(b"\n").map_err(|e| DbError::Io(e.to_string()))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spool_budget_includes_json_escaping_and_never_writes_an_oversized_record() {
        let sql = "SELECT '猫\n\"\\'";
        let bytes = serde_json::to_vec(sql).unwrap().len() as u64 + 1;
        assert!(bytes > sql.len() as u64);
        let mut output = Vec::new();
        assert!(write_record(&mut output, sql, bytes - 1).is_err());
        assert!(output.is_empty());
        assert_eq!(write_record(&mut output, sql, bytes).unwrap(), bytes);
        assert_eq!(output.len() as u64, bytes);
        assert_eq!(serde_json::from_slice::<String>(&output).unwrap(), sql);
    }

}
