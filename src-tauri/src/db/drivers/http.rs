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

    pub fn from_args(args: &crate::db::driver::ConnectArgs) -> Result<Self, DbError> {
        let secure = match args.ssl_mode.as_deref().map(|s| s.to_ascii_lowercase().replace('_', "-")) {
            None => args.ssl,
            Some(mode) if mode.is_empty() => args.ssl,
            Some(mode) if matches!(mode.as_str(), "disable" | "disabled") => false,
            Some(mode) if matches!(mode.as_str(), "require" | "required" | "prefer" | "preferred" | "verify-ca" | "verify-full" | "verify-identity") => true,
            Some(_) => return Err(DbError::ConnectFailed("Unknown HTTP database TLS mode".into())),
        };
        let mut builder = Client::builder().connect_timeout(std::time::Duration::from_secs(15))
            .danger_accept_invalid_certs(args.ssl_reject_unauthorized == Some(false));
        if secure {
            if let Some(path) = args.ca_cert_path.as_deref().filter(|s| !s.is_empty()) {
                let bytes = std::fs::read(path).map_err(|e| DbError::ConnectFailed(format!("Cannot read CA certificate: {e}")))?;
                let ca = reqwest::Certificate::from_pem(&bytes).map_err(|_| DbError::ConnectFailed("Invalid PEM CA certificate".into()))?;
                builder = builder.add_root_certificate(ca);
            }
        }
        let host = if args.host.contains(':') && !args.host.starts_with('[') { format!("[{}]", args.host) } else { args.host.clone() };
        let base_url = format!("{}://{}:{}", if secure { "https" } else { "http" }, host, args.port);
        Ok(Self { client: builder.build().map_err(|e| DbError::ConnectFailed(e.to_string()))?, base_url,
            auth: (!args.user.is_empty()).then(|| (args.user.clone(), args.secret.clone().unwrap_or_default())) })
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

/// Bound in-memory HTTP responses before parsing/formatting. Never quietly truncate
/// data: oversized results fail visibly so the caller can narrow the query.
pub async fn read_body(mut response: Response, limit: usize) -> Result<String, DbError> {
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err(DbError::QueryFailed("HTTP database response exceeds the size limit; narrow the query".into()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| DbError::QueryFailed(e.to_string()))? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(DbError::QueryFailed("HTTP database response exceeds the size limit; narrow the query".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| DbError::QueryFailed("Database HTTP response is not valid UTF-8".into()))
}

/// Send a request and surface HTTP errors as `DbError::ConnectFailed`.
pub async fn check_response_connect(resp: Response) -> Result<Response, DbError> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        let status = resp.status();
        let body = read_body(resp, 64 * 1024).await.unwrap_or_else(|e| e.to_string());
        Err(DbError::ConnectFailed(format!("HTTP {status}: {body}")))
    }
}

/// Send a request and surface HTTP errors as `DbError::QueryFailed`.
pub async fn check_response_query(resp: Response) -> Result<Response, DbError> {
    if resp.status().is_success() {
        Ok(resp)
    } else {
        let status = resp.status();
        let body = read_body(resp, 64 * 1024).await.unwrap_or_else(|e| e.to_string());
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            Err(DbError::AuthFailed)
        } else {
            Err(DbError::QueryFailed(format!("HTTP {status}: {body}")))
        }
    }
}
