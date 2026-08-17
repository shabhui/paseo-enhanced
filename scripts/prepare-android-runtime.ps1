param(
    [switch]$ValidateOnly,
    [string]$AndroidSdkRoot = $env:ANDROID_SDK_ROOT
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assets = Join-Path $repoRoot 'ZeroTermux-main\app\src\main\assets\paseo-runtime\packages'
$manifest = Join-Path $assets 'manifest.txt'
$paseoArchiveName = 'paseo-node-modules-arm64.tgz'
$paseoArchive = Join-Path $assets $paseoArchiveName
$termuxArchiveName = 'termux-node-runtime-arm64.tgz'
$termuxArchive = Join-Path $assets $termuxArchiveName
$legacyArchive = Join-Path $assets 'paseo-node-modules-arm64.tar.gz'
$legacyDebDirectory = Join-Path $assets 'deb'
$npmProject = Join-Path $PSScriptRoot 'android-runtime'
$ndkVersion = '29.0.14206865'
$legacyPackageName = 'com.termux'
$standalonePackageName = 'com.paseoe'
$latin1 = [System.Text.Encoding]::GetEncoding(28591)

if ($latin1.GetByteCount($legacyPackageName) -ne $latin1.GetByteCount($standalonePackageName)) {
    throw 'Relocated Termux package name must have the same byte length'
}

$packages = @(
    @{
        Name = 'c-ares_1.34.8_aarch64.deb'
        Path = 'pool/main/c/c-ares/c-ares_1.34.8_aarch64.deb'
        Sha256 = '7681fc23e822d7988ba8b2adf3468f93ae68f724dda365cff1385096a9fa87e6'
    },
    @{
        Name = 'libicu_78.3_aarch64.deb'
        Path = 'pool/main/libi/libicu/libicu_78.3_aarch64.deb'
        Sha256 = 'f536403f65a08fe0df6e7304184e902d54def77d5c3bd5edfd9109d57601d276'
    },
    @{
        Name = 'libsqlite_3.53.4_aarch64.deb'
        Path = 'pool/main/libs/libsqlite/libsqlite_3.53.4_aarch64.deb'
        Sha256 = '0e909ce0d50fe123305446cd22e0c5edf535d40344b9b065fbdcdee52f53198d'
    },
    @{
        Name = 'nodejs-lts_24.18.0-1_aarch64.deb'
        Path = 'pool/main/n/nodejs-lts/nodejs-lts_24.18.0-1_aarch64.deb'
        Sha256 = '490f4d08c45b25a7ea7db6ee466ebb3ee61f07083260b85332704ed018f59a87'
    }
)

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-AsciiOccurrenceCount([string]$Text, [string]$Needle) {
    $count = 0
    $offset = 0
    while (($offset = $Text.IndexOf($Needle, $offset, [System.StringComparison]::Ordinal)) -ge 0) {
        $count++
        $offset += $Needle.Length
    }
    return $count
}

function Replace-AsciiPackageName([string]$Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $contents = $latin1.GetString($bytes)
    $count = Get-AsciiOccurrenceCount $contents $legacyPackageName
    if ($count -eq 0) { return 0 }

    $relocated = $contents.Replace($legacyPackageName, $standalonePackageName)
    $relocatedBytes = $latin1.GetBytes($relocated)
    if ($relocatedBytes.Length -ne $bytes.Length) {
        throw "Binary relocation changed the size of $Path"
    }
    [System.IO.File]::WriteAllBytes($Path, $relocatedBytes)
    return $count
}

function Assert-NoLegacyPackageName([string]$Root) {
    $legacyMatches = foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File) {
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        $contents = $latin1.GetString([System.IO.File]::ReadAllBytes($file.FullName))
        if ($contents.Contains($legacyPackageName)) { $file.FullName }
    }
    if ($legacyMatches) {
        throw "Legacy Termux package name remains in runtime payload: $($legacyMatches[0])"
    }
}

function Assert-RuntimePayload {
    if (Test-Path -LiteralPath $legacyArchive) {
        throw 'Legacy .tar.gz runtime asset must be removed because aapt expands it'
    }
    if ((Test-Path -LiteralPath $legacyDebDirectory) -and
        (Get-ChildItem -LiteralPath $legacyDebDirectory -Filter '*.deb' -File)) {
        throw 'Bundled .deb files must be replaced by the relocated Termux runtime archive'
    }
    if (!(Test-Path -LiteralPath $manifest -PathType Leaf)) {
        throw 'Runtime manifest is missing'
    }

    $assetsRoot = [System.IO.Path]::GetFullPath($assets) + [System.IO.Path]::DirectorySeparatorChar
    $records = @{}
    foreach ($line in Get-Content -LiteralPath $manifest) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$') {
            throw "Invalid runtime manifest line: $line"
        }

        $relativePath = $Matches[2]
        $payloadPath = [System.IO.Path]::GetFullPath((Join-Path $assets $relativePath))
        if (!$payloadPath.StartsWith($assetsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Runtime manifest path escapes the package directory: $relativePath"
        }
        if (!(Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
            throw "Runtime payload is missing: $relativePath"
        }

        $actual = Get-Sha256 $payloadPath
        if ($actual -ne $Matches[1]) {
            throw "Checksum mismatch: $relativePath"
        }
        $records[$relativePath.Replace('\', '/')] = $true
    }

    if (!$records.ContainsKey($termuxArchiveName)) {
        throw "Runtime manifest entry is missing: $termuxArchiveName"
    }
    if (!$records.ContainsKey($paseoArchiveName)) {
        throw "Runtime manifest entry is missing: $paseoArchiveName"
    }

    $termuxEntries = & tar.exe -tzf $termuxArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect $termuxArchiveName"
    }
    $normalizedTermuxEntries = $termuxEntries | ForEach-Object { $_ -replace '^\./', '' }
    if ($normalizedTermuxEntries -notcontains 'bin/node') {
        throw 'Bundled Termux Node.js executable is missing'
    }
    if ($normalizedTermuxEntries -notcontains 'lib/libcares.so') {
        throw 'Bundled Termux c-ares library is missing'
    }

    $validationRoot = Join-Path ([System.IO.Path]::GetTempPath()) "paseo-runtime-validation-$PID-$([guid]::NewGuid().ToString('N'))"
    try {
        New-Item -ItemType Directory -Path $validationRoot | Out-Null
        & tar.exe -xzf $termuxArchive -C $validationRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to extract $termuxArchiveName for validation"
        }
        Assert-NoLegacyPackageName $validationRoot
    } finally {
        if (Test-Path -LiteralPath $validationRoot) {
            $resolvedValidationRoot = [System.IO.Path]::GetFullPath($validationRoot)
            $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
            if (!$resolvedValidationRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove validation directory outside the temporary root: $resolvedValidationRoot"
            }
            Remove-Item -LiteralPath $resolvedValidationRoot -Recurse -Force
        }
    }

    $paseoEntries = & tar.exe -tzf $paseoArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect $paseoArchiveName"
    }
    if ($paseoEntries -notcontains 'node_modules/@getpaseo/cli/bin/paseo') {
        throw 'Bundled Paseo CLI entry point is missing'
    }
    if ($paseoEntries -notcontains 'node_modules/@getpaseo/server/package.json') {
        throw 'Bundled Paseo server is missing'
    }
    if ($paseoEntries -notcontains 'node_modules/node-pty/prebuilds/android-arm64/pty.node') {
        throw 'Bundled Android node-pty module is missing'
    }
    if ($paseoEntries -notcontains 'node_modules/@parcel/watcher-android-arm64/watcher.node') {
        throw 'Bundled Android file watcher is missing'
    }

    $forbidden = $paseoEntries | Where-Object {
        $_ -match '\.(exe|dll)$' -or
        $_ -match 'node_modules/node-pty/prebuilds/(win32|darwin|linux)-' -or
        $_ -match 'node_modules/@parcel/watcher-(win32|darwin|linux|freebsd)-' -or
        $_ -match 'node_modules/@anthropic-ai/claude-agent-sdk-(win32|darwin|linux)-' -or
        $_ -match 'node_modules/sherpa-onnx-(win|linux|darwin)-'
    }
    if ($forbidden) {
        throw "Non-Android runtime payload is bundled: $($forbidden[0])"
    }
}

if ($ValidateOnly) {
    Assert-RuntimePayload
    Write-Host 'Android runtime payload is valid.'
    exit 0
}

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) "paseo-android-runtime-$PID-$([guid]::NewGuid().ToString('N'))"
try {
    $debDirectory = Join-Path $temporary 'deb'
    New-Item -ItemType Directory -Force -Path $temporary, $debDirectory | Out-Null

    $repository = 'https://packages-cf.termux.dev/apt/termux-main'
    foreach ($package in $packages) {
        $destination = Join-Path $debDirectory $package.Name
        $bundledSource = Join-Path $legacyDebDirectory $package.Name
        if ((Test-Path -LiteralPath $bundledSource -PathType Leaf) -and
            ((Get-Sha256 $bundledSource) -eq $package.Sha256)) {
            Copy-Item -LiteralPath $bundledSource -Destination $destination
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri "$repository/$($package.Path)" -OutFile $destination
        }
        if ((Get-Sha256 $destination) -ne $package.Sha256) {
            throw "Downloaded checksum mismatch: $($package.Name)"
        }
    }

    $lockFile = Join-Path $npmProject 'package-lock.json'
    if (!(Test-Path -LiteralPath $lockFile -PathType Leaf)) {
        throw "Npm lock file is missing: $lockFile"
    }
    Copy-Item -LiteralPath (Join-Path $npmProject 'package.json') -Destination $temporary
    Copy-Item -LiteralPath $lockFile -Destination $temporary

    Push-Location $temporary
    try {
        & npm.cmd ci --ignore-scripts --omit=dev --no-audit --no-fund --os=android --cpu=arm64
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    } finally {
        Pop-Location
    }

    if ([string]::IsNullOrWhiteSpace($AndroidSdkRoot)) {
        $AndroidSdkRoot = $env:ANDROID_HOME
    }
    if ([string]::IsNullOrWhiteSpace($AndroidSdkRoot)) {
        throw 'ANDROID_SDK_ROOT or ANDROID_HOME must point to the Android SDK'
    }

    $ndkToolchain = Join-Path $AndroidSdkRoot "ndk\$ndkVersion\toolchains\llvm\prebuilt\windows-x86_64\bin"
    $clang = Join-Path $ndkToolchain 'aarch64-linux-android23-clang++.cmd'
    $readelf = Join-Path $ndkToolchain 'llvm-readelf.exe'
    if (!(Test-Path -LiteralPath $clang -PathType Leaf) -or !(Test-Path -LiteralPath $readelf -PathType Leaf)) {
        throw "Android NDK $ndkVersion is missing from $AndroidSdkRoot"
    }

    $nodePackage = Join-Path $debDirectory 'nodejs-lts_24.18.0-1_aarch64.deb'
    $nativeStage = Join-Path $temporary '.android-native'
    $nodeData = Join-Path $nativeStage 'node-data'
    New-Item -ItemType Directory -Force -Path $nativeStage, $nodeData | Out-Null
    & tar.exe -xf $nodePackage -C $nativeStage
    if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the bundled Node.js package' }
    & tar.exe -xf (Join-Path $nativeStage 'data.tar.xz') -C $nodeData
    if ($LASTEXITCODE -ne 0) { throw 'Unable to extract the bundled Node.js headers' }

    $nodeInclude = Get-ChildItem -LiteralPath $nodeData -Recurse -Directory |
        Where-Object { $_.FullName -like '*\include\node' } |
        Select-Object -First 1 -ExpandProperty FullName
    if ([string]::IsNullOrWhiteSpace($nodeInclude)) {
        throw 'Bundled Node.js headers are missing'
    }

    $nodePty = Join-Path $temporary 'node_modules\node-pty'
    $nodeAddonApi = Join-Path $temporary 'node_modules\node-addon-api'
    $nodePtyPrebuilds = Join-Path $nodePty 'prebuilds'
    $nodePtyThirdParty = Join-Path $nodePty 'third_party'
    if (Test-Path -LiteralPath $nodePtyPrebuilds) {
        Remove-Item -LiteralPath $nodePtyPrebuilds -Recurse -Force
    }
    if (Test-Path -LiteralPath $nodePtyThirdParty) {
        Remove-Item -LiteralPath $nodePtyThirdParty -Recurse -Force
    }

    $androidPtyDirectory = Join-Path $nodePty 'prebuilds\android-arm64'
    $androidPty = Join-Path $androidPtyDirectory 'pty.node'
    New-Item -ItemType Directory -Force -Path $androidPtyDirectory | Out-Null
    & $clang -std=c++17 -shared -fPIC -O2 -fstack-protector-strong -pthread `
        -DNODE_GYP_MODULE_NAME=pty -DNAPI_VERSION=8 `
        "-I$nodeInclude" "-I$nodeAddonApi" `
        (Join-Path $nodePty 'src\unix\pty.cc') -o $androidPty
    if ($LASTEXITCODE -ne 0) { throw 'Unable to compile node-pty for Android arm64' }

    $dynamicSection = & $readelf -d $androidPty
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Android node-pty module' }
    if ($dynamicSection -match 'libc\.so\.6|libstdc\+\+\.so\.6|libgcc_s\.so') {
        throw 'Android node-pty module contains incompatible GNU runtime dependencies'
    }

    New-Item -ItemType Directory -Force -Path $assets | Out-Null
    if (Test-Path -LiteralPath $paseoArchive) {
        Remove-Item -LiteralPath $paseoArchive -Force
    }
    & tar.exe -czf $paseoArchive -C $temporary node_modules
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the Paseo runtime archive' }

    $termuxStage = Join-Path $temporary 'termux-prefix'
    New-Item -ItemType Directory -Path $termuxStage | Out-Null
    foreach ($package in $packages) {
        $packageStage = Join-Path $temporary "extract-$($package.Name)"
        New-Item -ItemType Directory -Path $packageStage | Out-Null
        & tar.exe -xf (Join-Path $debDirectory $package.Name) -C $packageStage
        if ($LASTEXITCODE -ne 0) { throw "Unable to unpack $($package.Name)" }
        & tar.exe --strip-components 6 -xf (Join-Path $packageStage 'data.tar.xz') -C $termuxStage
        if ($LASTEXITCODE -ne 0) { throw "Unable to stage $($package.Name)" }
    }

    $relocationCount = 0
    foreach ($file in Get-ChildItem -LiteralPath $termuxStage -Recurse -File) {
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        $relocationCount += Replace-AsciiPackageName $file.FullName
    }
    if ($relocationCount -eq 0) {
        throw 'Official Termux package name was not found in runtime payload'
    }
    Assert-NoLegacyPackageName $termuxStage

    if (Test-Path -LiteralPath $termuxArchive) {
        Remove-Item -LiteralPath $termuxArchive -Force
    }
    & tar.exe -czf $termuxArchive -C $termuxStage .
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create the Termux Node runtime archive' }
} finally {
    if (Test-Path -LiteralPath $temporary) {
        $resolvedTemporary = [System.IO.Path]::GetFullPath($temporary)
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if (!$resolvedTemporary.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove runtime directory outside the temporary root: $resolvedTemporary"
        }
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
}

if (Test-Path -LiteralPath $legacyDebDirectory) {
    $resolvedDebDirectory = [System.IO.Path]::GetFullPath($legacyDebDirectory)
    $resolvedAssets = [System.IO.Path]::GetFullPath($assets) + [System.IO.Path]::DirectorySeparatorChar
    if (!$resolvedDebDirectory.StartsWith($resolvedAssets, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove legacy packages outside runtime assets: $resolvedDebDirectory"
    }
    Remove-Item -LiteralPath $resolvedDebDirectory -Recurse -Force
}

$manifestLines = @(
    "$(Get-Sha256 $termuxArchive)  $termuxArchiveName",
    "$(Get-Sha256 $paseoArchive)  $paseoArchiveName"
)
[System.IO.File]::WriteAllText(
    $manifest,
    ($manifestLines -join "`n") + "`n",
    [System.Text.Encoding]::ASCII)

Assert-RuntimePayload
Write-Host 'Android runtime payload prepared and validated.'
