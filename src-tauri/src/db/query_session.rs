//! Physical SQL-session contracts. Transaction state is observed from the engine, not guessed from SQL text.
use serde::{Serialize,Deserialize};

#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub enum TransactionState { Idle, Active, Failed, Unknown }

#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub enum TransactionAction { Begin, Commit, Rollback }

#[derive(Debug,Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct QuerySessionInfo {
    pub id:String,
    pub transaction_state:TransactionState,
    pub busy:bool,
    pub can_cancel:bool,
    pub lease_seconds:u64,
}
