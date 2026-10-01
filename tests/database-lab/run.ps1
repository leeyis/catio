param(
  [Parameter(Mandatory=$true)][string]$EnvFile,
  [string]$Server = '127.0.0.1',
  [int]$SqlServerPort = 51433,
  [switch]$RemoteHttpRelays,
  [string]$CaCert = ''
)
# Explicit one-shot test runner, not a scheduler. Never prints fixture credentials.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$fixture = @{}
Get-Content -Encoding UTF8 $EnvFile | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') { $fixture[$matches[1]] = $matches[2] }
}
$password = $fixture['CATIO_LAB_PASSWORD']
if (-not $password) { throw 'CATIO_LAB_PASSWORD is required in the fixture env file' }
if ($password.Contains(':')) { throw 'The legacy integration-test URL format cannot encode a colon in the fixture password. Real connection APIs use typed credentials.' }
$null = Get-Command java -ErrorAction Stop
$env:CATIO_TEST_PG_URL = "${Server}:55432:postgres:${password}:catio"
$env:CATIO_TEST_MYSQL_URL = "${Server}:53306:root:${password}:catio"
$env:CATIO_TEST_MSSQL_URL = "${Server}:${SqlServerPort}:sa:${password}:master"
$env:CATIO_TEST_CLICKHOUSE_URL = "${Server}:58123:catio:${password}:default"
$env:CATIO_TEST_MONGO_URL = "${Server}:57017:catio:${password}:admin"
$env:CATIO_TEST_REDIS_URL = "${Server}:56379::${password}:0"
$esPort = if ($RemoteHttpRelays) { 59201 } else { 59200 }
$rqlitePort = if ($RemoteHttpRelays) { 54002 } else { 54001 }
$env:CATIO_TEST_ES_URL = "${Server}:${esPort}:::"
$env:CATIO_TEST_RQLITE_URL = "${Server}:${rqlitePort}:::"
$env:CATIO_TEST_JDBC = '1'
$env:CATIO_JDBC_PLUGIN_JAR = Join-Path $repo 'src-tauri/resources/catio-jdbc-plugin.jar'
if ($CaCert) {
  $env:CATIO_TEST_CA_CERT = (Resolve-Path $CaCert).Path
  $env:CATIO_TEST_CH_TLS_URL = "${Server}:59443:catio:${password}:default"
}
Write-Host 'Enabled fixtures: PostgreSQL, MySQL, SQL Server, ClickHouse, MongoDB, Redis, Elasticsearch, rqlite; SQLite, DuckDB, JDBC/H2'
Write-Host ('TLS fixture enabled: ' + [bool]$CaCert)
$targets = @('db_postgres','db_mysql','db_sqlserver','db_clickhouse','db_mongo','db_redis','db_elasticsearch','db_rqlite',
  'db_sqlite','db_duckdb','db_dml_roundtrip','db_jdbc_h2','db_parity','db_extended_parity','db_query_control',
  'db_duckdb_transaction_regression','db_http_parity','server_db','server_database_workflows','server_isolation','server_mcp')
$arguments = @('test','--manifest-path',(Join-Path $repo 'src-tauri/Cargo.toml'),'--lib','--no-fail-fast')
foreach ($target in $targets) { $arguments += @('--test', $target) }
# Windows PowerShell 5 wraps native stderr (including Cargo progress) as error
# records when the caller redirects streams. Progress is not a build failure.
$ErrorActionPreference = 'Continue'
& cargo @arguments
$code = $LASTEXITCODE
exit $code
