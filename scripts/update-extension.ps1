[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $PSScriptRoot '..'),
    [string]$ArchivePath,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding

function Stop-Update {
    param([string]$Message)
    $exception = New-Object InvalidOperationException($Message)
    $exception.Data['WDS_ChineseMessage'] = $Message
    throw $exception
}

function Get-UpdateErrorMessage {
    param($ErrorRecord)
    $exception = $ErrorRecord.Exception
    while ($exception) {
        if ($exception.Data.Contains('WDS_ChineseMessage')) { return $exception.Data['WDS_ChineseMessage'] }
        if ($exception -is [OperationCanceledException]) { return '网络请求超时，请检查网络后重试。' }
        if ($exception -is [Net.Http.HttpRequestException]) { return '无法连接 GitHub 或下载发行版，请检查网络后重试。' }
        if ($exception -is [UnauthorizedAccessException]) { return '没有文件访问权限，请确认插件目录可以写入，并关闭占用文件的程序。' }
        if ($exception -is [IO.InvalidDataException]) { return '压缩包损坏或格式无效，请重新下载。' }
        if ($exception -is [IO.FileNotFoundException] -or $exception -is [IO.DirectoryNotFoundException]) {
            return '所需文件或目录不存在，请确认插件目录及压缩包路径。'
        }
        if ($exception -is [IO.IOException]) { return '无法读写文件，请检查文件是否被占用，以及磁盘空间是否充足。' }
        $exception = $exception.InnerException
    }
    if ($ErrorRecord.FullyQualifiedErrorId -match 'PathNotFound|ItemNotFound') {
        return '所需文件或目录不存在，请确认插件目录及压缩包路径。'
    }
    if ($ErrorRecord.FullyQualifiedErrorId -match 'InvalidJson|ConvertFromJson') {
        return '插件配置文件或更新记录格式无效，请检查文件内容。'
    }
    return '操作未完成，请检查插件文件是否完整、目录是否可以写入，以及网络是否正常。'
}

function Get-SafeChildPath {
    param([string]$Root, [string]$RelativePath)
    $relative = $RelativePath.Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.StartsWith('/') -or
        $relative.Contains(':') -or @($relative.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count) {
        Stop-Update "压缩包中含有不安全的路径：$RelativePath"
    }
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $child = [IO.Path]::GetFullPath((Join-Path $rootFull $relative))
    if (-not $child.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Update "文件路径超出了预期目录：$RelativePath"
    }
    return $child
}

function Assert-PlainInstallPath {
    param([string]$Path, [string]$Root)
    $cursor = $Path
    while ($cursor.Length -ge $Root.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                Stop-Update "无法通过符号链接或目录联接更新文件：$cursor"
            }
            if ($cursor -ne $Path -and -not $item.PSIsContainer) {
                Stop-Update "目标目录被同名文件占用：$cursor"
            }
        }
        if ($cursor -eq $Root) { break }
        $cursor = Split-Path -Parent $cursor
    }
}

function Get-FileSha256 {
    param([string]$Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)) }
    finally { $stream.Dispose(); $hasher.Dispose() }
}

function Read-ExtensionManifest {
    param([string]$Root)
    $manifestPath = Get-SafeChildPath $Root 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.name -ne 'WorldQuant Scope' -or $manifest.manifest_version -ne 3 -or
        $manifest.version -notmatch '^\d+\.\d+\.\d+$') {
        Stop-Update '该目录中没有有效的 WorldQuant Scope 插件。'
    }
    return $manifest
}

function Assert-ReleaseFiles {
    param([string]$Root, $Manifest)
    $required = @('src/background/background.js', 'src/ui/sidebar/sidebar.html', 'src/shared/dataStore.js', 'img/logo.png')
    $required += $Manifest.background.service_worker
    $required += $Manifest.side_panel.default_path
    foreach ($contentScript in $Manifest.content_scripts) {
        foreach ($property in @('js', 'css')) {
            if ($contentScript.PSObject.Properties[$property]) { $required += $contentScript.$property }
        }
    }
    foreach ($relative in ($required | Select-Object -Unique)) {
        if ($relative -notmatch '^(src|img)/' -or -not (Test-Path -LiteralPath (Get-SafeChildPath $Root $relative) -PathType Leaf)) {
            Stop-Update "发行版压缩包缺少必需的插件文件：$relative"
        }
    }
}

function Expand-ReleaseArchive {
    param([string]$ZipPath, [string]$Destination)
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $expandedBytes = 0L
        if ($zip.Entries.Count -gt 10000) { Stop-Update '发行版压缩包中的文件数量异常。' }
        foreach ($entry in $zip.Entries) {
            $expandedBytes += $entry.Length
            if ($expandedBytes -gt 256MB) { Stop-Update '发行版压缩包解压后的大小超出限制。' }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                Stop-Update "发行版压缩包中不允许包含符号链接：$($entry.FullName)"
            }
            $destinationPath = Get-SafeChildPath $Destination $entry.FullName
            if ($entry.FullName.EndsWith('/')) {
                [IO.Directory]::CreateDirectory($destinationPath) | Out-Null
            } else {
                [IO.Directory]::CreateDirectory((Split-Path -Parent $destinationPath)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destinationPath, $false)
            }
        }
    } finally {
        $zip.Dispose()
    }
    if (Test-Path -LiteralPath (Join-Path $Destination 'manifest.json') -PathType Leaf) { return $Destination }
    $roots = @(Get-ChildItem -LiteralPath $Destination -Directory | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json') -PathType Leaf
    })
    if ($roots.Count -ne 1) { Stop-Update '发行版压缩包必须包含且仅包含一个插件目录。' }
    return $roots[0].FullName
}

function Get-LatestReleaseTag {
    param($Client)
    # The public redirect avoids the shared anonymous GitHub API rate limit.
    $response = $Client.GetAsync('https://github.com/AlphaQuantKit/WebDataScope/releases/latest',
        [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    try {
        if (-not $response.IsSuccessStatusCode) { Stop-Update "查询最新版本失败，服务器返回 HTTP $([int]$response.StatusCode)。请稍后重试。" }
        $uri = $response.RequestMessage.RequestUri
        if ($uri.Host -ne 'github.com' -or $uri.AbsolutePath -notmatch '^/AlphaQuantKit/WebDataScope/releases/tag/(v?\d+\.\d+\.\d+)$') {
            Stop-Update 'GitHub 未返回有效的 WebDataScope 正式发行版。'
        }
        return $Matches[1]
    } finally {
        $response.Dispose()
    }
}

function Save-ReleaseArchive {
    param($Client, [string]$Tag, [string]$Destination)
    $url = 'https://codeload.github.com/AlphaQuantKit/WebDataScope/zip/refs/tags/' + [Uri]::EscapeDataString($Tag)
    $response = $Client.GetAsync($url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    try {
        if (-not $response.IsSuccessStatusCode) { Stop-Update "下载发行版失败，服务器返回 HTTP $([int]$response.StatusCode)。请稍后重试。" }
        $stream = [IO.File]::Create($Destination)
        try { $response.Content.CopyToAsync($stream).GetAwaiter().GetResult() } finally { $stream.Dispose() }
    } finally {
        $response.Dispose()
    }
}

function Assert-LocalChanges {
    param([string]$Root, $Plan, [string]$InstalledVersion)
    $changed = @($Plan | Where-Object {
        -not $_.Existed -or (Get-FileSha256 $_.Source) -ne (Get-FileSha256 $_.Destination)
    })
    $previousFiles = $null
    $statePath = Get-SafeChildPath $Root '.webdatascope-update-state.json'
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($state.PSObject.Properties['version'] -and $state.PSObject.Properties['files'] -and
            $state.version -eq $InstalledVersion) { $previousFiles = $state.files }
    }
    $unchangedSinceUpdate = @{}
    foreach ($entry in $changed) {
        $previous = if ($previousFiles) { $previousFiles.PSObject.Properties[$entry.Relative] } else { $null }
        if (-not $previous) { continue }
        if (-not $entry.Existed -or (Get-FileSha256 $entry.Destination) -ne $previous.Value) {
            Stop-Update "更新会覆盖本地修改：$($entry.Relative)。请先保存或备份这些修改。现有文件未改动。"
        }
        $unchangedSinceUpdate[$entry.Relative] = $true
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root '.git')) -or -not $changed.Count) { return $false }

    # Git is optional. Its metadata alone must never prevent an update.
    $gitCommand = Get-Command -Name git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gitCommand) { return $true }
    $pathspecs = @($changed | ForEach-Object { ':(literal)' + $_.Relative })
    try { $status = @(& $gitCommand.Source -C $Root status --porcelain=v1 -z --untracked-files=all -- $pathspecs 2>$null) }
    catch { Stop-Update '无法检查本地 Git 修改。现有文件未改动。' }
    if ($LASTEXITCODE -ne 0) { Stop-Update '无法检查本地 Git 修改。现有文件未改动。' }
    $records = ([string]::Join("`n", $status)).Split([char]0)
    $localChanges = @()
    for ($index = 0; $index -lt $records.Length; $index++) {
        $record = $records[$index]
        if ($record.Length -lt 4) { continue }
        $flags = $record.Substring(0, 2)
        $relative = $record.Substring(3)
        if ($flags -match '[RC]') { $index++ }
        if ($unchangedSinceUpdate.ContainsKey($relative)) { continue }
        # Users can copy these two updater files into an older checkout to bootstrap updates.
        if ($flags -eq '??' -and $relative -in @('update.bat', 'scripts/update-extension.ps1')) { continue }
        $localChanges += $relative
    }
    if ($localChanges.Count) {
        Stop-Update ('更新会覆盖本地修改：' + ($localChanges -join '、') + '。请先保存或备份这些修改。现有文件未改动。')
    }
    return $false
}

$temporaryRoot = $null
$keepBackup = $false
$updateMutex = $null
$ownsMutex = $false
$exitCode = 0
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.Net.Http
    $installRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $InstallDirectory).Path).TrimEnd('\', '/')
    Assert-PlainInstallPath $installRoot $installRoot
    $installedManifest = Read-ExtensionManifest $installRoot
    $rootHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $rootHash = [BitConverter]::ToString($rootHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($installRoot.ToLowerInvariant()))).Replace('-', '')
    } finally { $rootHasher.Dispose() }
    $updateMutex = New-Object Threading.Mutex($false, ('Local\WebDataScope-update-' + $rootHash))
    try { $ownsMutex = $updateMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { Stop-Update '该插件目录已有更新器正在运行，请等待其完成。' }

    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('WebDataScope-update-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
    $expectedVersion = $null
    if ($ArchivePath) {
        $zipPath = (Resolve-Path -LiteralPath $ArchivePath).Path
    } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $client = New-Object Net.Http.HttpClient
        $client.Timeout = [TimeSpan]::FromSeconds(90)
        $client.DefaultRequestHeaders.UserAgent.ParseAdd('WebDataScope-Updater/1.0')
        try {
            $tag = Get-LatestReleaseTag $client
            $expectedVersion = $tag -replace '^v', ''
            Write-Host "当前版本：$($installedManifest.version)；最新正式版本：$expectedVersion"
            if ([version]$expectedVersion -le [version]$installedManifest.version) {
                Write-Host '当前已是最新版本，无需更新。'
                exit 0
            }
            $zipPath = Join-Path $temporaryRoot 'release.zip'
            Write-Host '正在下载最新正式版本……'
            Save-ReleaseArchive $client $tag $zipPath
        } finally { $client.Dispose() }
    }

    $payloadRoot = Expand-ReleaseArchive $zipPath (Join-Path $temporaryRoot 'release')
    $releaseManifest = Read-ExtensionManifest $payloadRoot
    Assert-ReleaseFiles $payloadRoot $releaseManifest
    if ($expectedVersion -and $releaseManifest.version -ne $expectedVersion) { Stop-Update '压缩包中的插件版本与 GitHub 发行标签不一致。' }
    if ([version]$releaseManifest.version -le [version]$installedManifest.version) {
        Write-Host '当前版本相同或更新，无需更新。现有文件未改动。'
        exit 0
    }

    # Only extension runtime files and the updater are replaced. Browser storage lives outside this directory.
    $relativePaths = @()
    foreach ($folder in @('src', 'img')) {
        $relativePaths += @(Get-ChildItem -LiteralPath (Join-Path $payloadRoot $folder) -File -Recurse | ForEach-Object {
            $_.FullName.Substring($payloadRoot.Length + 1).Replace('\', '/')
        })
    }
    foreach ($relative in @('README.md', 'RELEASE_NOTES.md', 'LICENSE', 'update.bat', 'scripts/update-extension.ps1')) {
        if (Test-Path -LiteralPath (Get-SafeChildPath $payloadRoot $relative) -PathType Leaf) { $relativePaths += $relative }
    }
    # Replace the manifest last, after all referenced files are in place.
    $relativePaths = @($relativePaths | Sort-Object -Unique) + @('manifest.json')
    $plan = @($relativePaths | ForEach-Object {
        $destination = Get-SafeChildPath $installRoot $_
        Assert-PlainInstallPath $destination $installRoot
        if (Test-Path -LiteralPath $destination -PathType Container) { Stop-Update "目标文件位置被同名目录占用：$destination" }
        [PSCustomObject]@{
            Relative = $_
            Source = Get-SafeChildPath $payloadRoot $_
            Destination = $destination
            Backup = Get-SafeChildPath (Join-Path $temporaryRoot 'backup') $_
            Existed = Test-Path -LiteralPath $destination -PathType Leaf
        }
    })
    if ($CheckOnly) {
        Write-Host "更新检查通过：$($installedManifest.version) → $($releaseManifest.version)，共 $($plan.Count) 个文件。现有文件未改动。"
        exit 0
    }

    $retainRecoveryBackup = Assert-LocalChanges $installRoot $plan $installedManifest.version
    $nextStateFiles = [ordered]@{}
    foreach ($entry in $plan) { $nextStateFiles[$entry.Relative] = Get-FileSha256 $entry.Source }
    $nextStatePath = Join-Path $temporaryRoot 'next-update-state.json'
    @{ version = $releaseManifest.version; files = $nextStateFiles } | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath $nextStatePath -Encoding UTF8
    $stateDestination = Get-SafeChildPath $installRoot '.webdatascope-update-state.json'
    Assert-PlainInstallPath $stateDestination $installRoot
    if (Test-Path -LiteralPath $stateDestination -PathType Container) { Stop-Update '更新记录文件的位置被同名目录占用。' }
    $plan += [PSCustomObject]@{
        Relative = '.webdatascope-update-state.json'
        Source = $nextStatePath
        Destination = $stateDestination
        Backup = Get-SafeChildPath (Join-Path $temporaryRoot 'backup') '.webdatascope-update-state.json'
        Existed = Test-Path -LiteralPath $stateDestination -PathType Leaf
    }

    foreach ($entry in $plan) {
        if ($entry.Existed) {
            [IO.Directory]::CreateDirectory((Split-Path -Parent $entry.Backup)) | Out-Null
            Copy-Item -LiteralPath $entry.Destination -Destination $entry.Backup -Force
        }
    }
    $applied = New-Object 'System.Collections.Generic.List[object]'
    try {
        foreach ($entry in $plan) {
            [IO.Directory]::CreateDirectory((Split-Path -Parent $entry.Destination)) | Out-Null
            $applied.Add($entry)
            Copy-Item -LiteralPath $entry.Source -Destination $entry.Destination -Force
            if ((Get-FileSha256 $entry.Source) -ne (Get-FileSha256 $entry.Destination)) {
                Stop-Update "文件校验失败：$($entry.Relative)"
            }
        }
    } catch {
        $updateError = $_
        for ($index = $applied.Count - 1; $index -ge 0; $index--) {
            $entry = $applied[$index]
            try {
                Assert-PlainInstallPath $entry.Destination $installRoot
                if ($entry.Existed) {
                    if (-not (Test-Path -LiteralPath $entry.Destination -PathType Leaf) -or
                        (Get-FileSha256 $entry.Backup) -ne (Get-FileSha256 $entry.Destination)) {
                        Copy-Item -LiteralPath $entry.Backup -Destination $entry.Destination -Force
                    }
                }
                elseif (Test-Path -LiteralPath $entry.Destination -PathType Leaf) { Remove-Item -LiteralPath $entry.Destination -Force }
            } catch {
                $keepBackup = $true
                Write-Host "警告：无法恢复 $($entry.Relative)：$(Get-UpdateErrorMessage $_)" -ForegroundColor Yellow
            }
        }
        if ($keepBackup) { Write-Host "警告：恢复文件已保留在：$temporaryRoot" -ForegroundColor Yellow }
        else { Write-Host '更新失败，已恢复原来的插件文件。' }
        throw $updateError
    }
    Write-Host "已在原目录更新至 $($releaseManifest.version)，浏览器配置和导入数据已保留。"
    Write-Host '请打开 chrome://extensions 或 edge://extensions，点击 WorldQuant Scope 的“重新加载”，然后刷新 WorldQuant 页面。'
    Write-Host '请保留原安装目录和已安装的扩展，以继续使用原来的扩展 ID 和配置。'
    if ($retainRecoveryBackup) {
        $keepBackup = $true
        Write-Host "未检测到 Git，已保留此目录的恢复备份：$temporaryRoot"
    }
} catch {
    Write-Host "更新失败：$(Get-UpdateErrorMessage $_)" -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($temporaryRoot -and -not $keepBackup -and (Test-Path -LiteralPath $temporaryRoot)) {
        $cleanupPath = [IO.Path]::GetFullPath($temporaryRoot)
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if ($cleanupPath.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $cleanupPath) -match '^WebDataScope-update-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $cleanupPath -Recurse -Force
        }
    }
    if ($ownsMutex) { $updateMutex.ReleaseMutex() }
    if ($updateMutex) { $updateMutex.Dispose() }
}
exit $exitCode
