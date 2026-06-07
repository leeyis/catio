// adapted from dbx crates/dbx-core/src/db/clickhouse_driver.rs, Apache-2.0
//! Shared HTTP client helper for the reqwest-based drivers (ClickHouse, Elasticsearch, rqlite).
//! Wraps `reqwest::Client` with optional basic-auth and uniform error mapping.

use reqwest::{Client, RequestBuilder, Response, StatusCode};
use crate::db::DbError;

/// Thin wrapper around `reqwest::Client` that carries optional credentials and a base URL.
/// `reqwest::Client` is already internally `Arc`-backed — cheap to clone, no mutex needed.
#[derive(Clone)]
pub struct HttpClient {
    pub client: Client,
    pub base_url: String,
    pub auth: Option<(String, String)>,
}

impl HttpClient {
    pub fn new(base_url: impl Into<String>, user: Option<&str>, password: Option<&str>) -> Self {
        let client = Client::builder()
            .build()
            .unwrap_or_default();
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let auth = match (user, password) {
            (Some(u), _) if !u.is_empty() => {
                Some((u.to_string(), password.unwrap_or("").to_string()))
            }
            _ => None,
        };
        Self { client, base_url, auth }
    }

    pub fn get(&self, path: &str) -> RequestBuilder {
        let req = self.client.get(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    pub fn post(&self, path: &str) -> RequestBuilder {
        let req = self.client.post(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    pub fn put(&self, path: &str) -> RequestBuilder {
        let req = self.client.put(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    pub fn delete(&self, path: &str) -> RequestBuilder {
        let req = self.client.delete(format!("{}{}", self.base_url, path));
        self.with_auth(req)
    }

    fn with_auth(&self, req: RequestBuilder) -> RequestBuilder {
        if let Some((ref user, ref pass)) = self.auth {
            req.basic_auth(user, Some(pass))
        } else {
            req
        }
    }
}

/// Send a request and surface HTTP errors as `DbError::ConnectFailed`.
pub async fn check_response_connect(resp: Response) -> Result<Response, DbError> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(DbError::ConnectFailed(format!("HTTP {status}: {body}")))
    }
}

/// Send a request and surface HTTP errors as `DbError::QueryFailed`.
pub async fn check_response_query(resp: Response) -> Result<Response, DbError> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            Err(DbError::AuthFailed)
        } else {
            Err(DbError::QueryFailed(format!("HTTP {status}: {body}")))
        }
    }
}
