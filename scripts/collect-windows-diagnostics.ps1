#requires -Version 5.1
<#
Offline collector for Catio, including older releases with no runtime log.
Does not read connection profiles, browser storage, environment dumps or credentials.
No network access and no automatic upload. Inspect the ZIP before sharing it.
#>
[CmdletBinding()]
param([string]$OutputDirectory = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$work = [IO.Path]::GetFullPath((Join-Path $tempRoot "catio-diagnostics-$suffix"))
$null = New-Item -ItemType Directory -Path $work
$null = New-Item -ItemType Directory -Path $OutputDirectory -Force
$archive = Join-Path (Resolve-Path -LiteralPath $OutputDirectory).Path "catio-diagnostics-$suffix.zip"

try {
    $os = Get-CimInstance Win32_OperatingSystem
    $processes = @(Get-Process catio, msedgewebview2 -ErrorAction SilentlyContinue | ForEach-Object {
        [ordered]@{
            name = $_.ProcessName; pid = $_.Id; responding = $_.Responding
            hasMainWindow = ($_.MainWindowHandle -ne [IntPtr]::Zero)
            version = $_.FileVersion
        }
    })
    $webviews = @()
    foreach ($base in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients', 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients')) {
        if (Test-Path -LiteralPath $base) {
            $webviews += @(Get-ChildItem -LiteralPath $base -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue |
                Where-Object { $_.name -match 'WebView2' } | Select-Object name, pv)
        }
    }
    $windows = @()
    try {
        # Read-only window metadata: no titles, screenshots or user content.
        if (-not ('CatioDiagnosticWindows' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CatioDiagnosticWindows {
    public class WindowInfo {
        public long handle; public uint pid; public bool visible; public bool minimized;
        public int left; public int top; public int right; public int bottom;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    private delegate bool Callback(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr param);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    public static WindowInfo[] Read(uint[] pids) {
        var result = new List<WindowInfo>();
        if (pids == null || pids.Length == 0) return result.ToArray();
        EnumWindows(delegate(IntPtr window, IntPtr param) {
            uint pid; GetWindowThreadProcessId(window, out pid);
            if (Array.IndexOf(pids, pid) < 0) return true;
            Rect rect; GetWindowRect(window, out rect);
            result.Add(new WindowInfo { handle = window.ToInt64(), pid = pid,
                visible = IsWindowVisible(window), minimized = IsIconic(window),
                left = rect.Left, top = rect.Top, right = rect.Right, bottom = rect.Bottom });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@
        }
        $catioPids = [System.UInt32[]]@($processes | Where-Object { $_.name -eq 'catio' } | ForEach-Object { $_.pid })
        $windows = @([CatioDiagnosticWindows]::Read($catioPids))
    } catch {
        ('Window metadata unavailable (restricted PowerShell or process access). Error type: ' + $_.Exception.GetType().FullName) |
            Set-Content -LiteralPath (Join-Path $work 'window-note.txt') -Encoding UTF8
    }
    [ordered]@{
        collectedAt = [DateTime]::UtcNow.ToString('o')
        windows = @{ edition = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture }
        processes = $processes
        webview2 = $webviews
        windowStates = $windows
        note = 'WebView2 processes may belong to other applications. No process command lines or environment variables collected.'
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $work 'system.json') -Encoding UTF8

    $logRoots = @((Join-Path $env:LOCALAPPDATA 'io.catio.app\logs'), (Join-Path $env:TEMP 'io.catio.app\logs'))
    for ($i = 0; $i -lt $logRoots.Count; $i++) {
        if (!(Test-Path -LiteralPath $logRoots[$i])) { continue }
        $destination = Join-Path $work "logs-$i"
        $null = New-Item -ItemType Directory -Path $destination
        # Exclude MCP logs and all app data: they can contain connection data.
        Get-ChildItem -LiteralPath $logRoots[$i] -File |
            Where-Object { $_.Name -match '^catio-(runtime|panic|diagnostics)\.log(\.1)?$' } |
            Copy-Item -Destination $destination
    }

    # Read only Application Error fields, not raw event messages, WER reports,
    # dumps, command lines or arbitrary fault payloads.
    $crashes = @()
    try {
        $events = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 300 -ErrorAction Stop
        foreach ($event in $events) {
            $xml = [xml]$event.ToXml()
            $fields = @{}
            foreach ($data in $xml.Event.EventData.Data) { $fields[[string]$data.Name] = [string]$data.'#text' }
            if ($fields.AppName -notmatch '^(catio|msedgewebview2)\.exe$') { continue }
            $crashes += [ordered]@{
                time = $event.TimeCreated.ToUniversalTime().ToString('o'); application = $fields.AppName
                version = $fields.AppVersion; module = [IO.Path]::GetFileName($fields.ModuleName)
                exceptionCode = $fields.ExceptionCode; faultOffset = $fields.FaultingOffset
            }
        }
    } catch {
        'No matching application crash events, or access to the event log was unavailable.' |
            Set-Content -LiteralPath (Join-Path $work 'event-log-note.txt') -Encoding UTF8
    }
    ConvertTo-Json -InputObject @($crashes) -Depth 4 | Set-Content -LiteralPath (Join-Path $work 'crashes.json') -Encoding UTF8
    'No data was uploaded. Review this archive before sending it to support.' |
        Set-Content -LiteralPath (Join-Path $work 'README.txt') -Encoding UTF8
    Compress-Archive -Path (Join-Path $work '*') -DestinationPath $archive
    # .NET works even on locked-down machines with reduced PowerShell modules.
    $stream = [IO.File]::OpenRead($archive)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
    [PSCustomObject]@{ Path = $archive; SHA256 = $hash } | Format-List
} finally {
    # Delete only the unique directory created by this invocation, in one shell.
    $resolvedWork = [IO.Path]::GetFullPath($work)
    if ($resolvedWork.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedWork) -eq "catio-diagnostics-$suffix") {
        Remove-Item -LiteralPath $resolvedWork -Recurse -Force
    }
}
