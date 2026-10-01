param(
  [Parameter(Mandatory=$true)][string]$ServerAddress,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
# PowerShell 7 / .NET: disposable fixture certificates only. Does NOT install a CA
# in any operating-system trust store. The root private key is never written out.
$ErrorActionPreference = 'Stop'
$null = New-Item -ItemType Directory -Force $OutputDirectory
$now = [DateTimeOffset]::UtcNow
$rootKey = [System.Security.Cryptography.RSA]::Create(2048)
$serverKey = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $rootRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=Catio database test fixture CA', $rootKey,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $rootRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true))
  $rootRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign,$true))
  $root = $rootRequest.CreateSelfSigned($now.AddDays(-2), $now.AddDays(30))
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=$ServerAddress", $serverKey,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $ip = $null
  if ([System.Net.IPAddress]::TryParse($ServerAddress,[ref]$ip)) { $san.AddIpAddress($ip) } else { $san.AddDnsName($ServerAddress) }
  $request.CertificateExtensions.Add($san.Build())
  $oids = [System.Security.Cryptography.OidCollection]::new()
  $null = $oids.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$false))
  $serial = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
  $serial[0] = $serial[0] -band 127
  $leaf = $request.Create($root, $now.AddDays(-2), $now.AddDays(30), $serial)
  [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'root.crt'), $root.ExportCertificatePem())
  [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'server.crt'), $leaf.ExportCertificatePem())
  [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'server.key'), $serverKey.ExportPkcs8PrivateKeyPem())
  Write-Host 'Created a 30-day fixture CA and server certificate. Private key stays in the specified fixture directory; keep it out of Git.'
} finally { $rootKey.Dispose(); $serverKey.Dispose() }
