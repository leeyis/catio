# Rebuild the JDBC sidecar fat jar and re-vendor it into src-tauri/resources/.
# Run this only when the Java source under src-tauri/jdbc-plugin/src changes.
#
# Requires JDK 17+. Maven is found on PATH, else point $env:MVN_CMD at a portable
# mvn(.cmd) — no system install needed (a portable Apache Maven zip + JAVA_HOME
# is enough).
#
#   pwsh scripts/build-jdbc-plugin.ps1

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pom  = Join-Path $repo 'src-tauri/jdbc-plugin/pom.xml'
$out  = Join-Path $repo 'src-tauri/jdbc-plugin/target/catio-jdbc-plugin.jar'
$dest = Join-Path $repo 'src-tauri/resources/catio-jdbc-plugin.jar'

$mvn = if ($env:MVN_CMD) { $env:MVN_CMD } else { 'mvn' }

& $mvn -q -DskipTests -f $pom package
if ($LASTEXITCODE -ne 0) { throw "mvn package failed (exit $LASTEXITCODE)" }
if (-not (Test-Path $out) -or (Get-Item $out).Length -eq 0) { throw "built jar missing or empty: $out" }

New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
Copy-Item $out $dest -Force
Write-Host "Vendored $([math]::Round((Get-Item $dest).Length/1MB,2)) MB → $dest"
Write-Host "Now commit src-tauri/resources/catio-jdbc-plugin.jar"
