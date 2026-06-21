param(
  [ValidateSet("assembleDebug", "assembleRelease", "test", "clean")]
  [string]$Task = "assembleDebug",
  [string]$GradleVersion = "8.10.2"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$AndroidDir = Join-Path $RepoRoot "android"
$BootstrapDir = Join-Path $AndroidDir ".gradle-bootstrap"
$GradleDir = Join-Path $BootstrapDir "gradle-$GradleVersion"
$GradleBat = Join-Path $GradleDir "bin\gradle.bat"
$GradleZip = Join-Path $BootstrapDir "gradle-$GradleVersion-bin.zip"
$DistributionUrl = "https://services.gradle.org/distributions/gradle-$GradleVersion-bin.zip"

function Resolve-AndroidSdk {
  $candidates = @(@(
    $env:ANDROID_SDK_ROOT,
    $env:ANDROID_HOME,
    (Join-Path $env:LOCALAPPDATA "Android\Sdk")
  ) | Where-Object { $_ -and (Test-Path $_) })

  if (-not $candidates.Count) {
    throw "Android SDK not found. Install Android Studio or set ANDROID_SDK_ROOT."
  }

  return (Resolve-Path $candidates[0]).Path
}

function Resolve-JavaHome {
  $studioJava = "C:\Program Files\Android\Android Studio\jbr"
  if (Test-Path (Join-Path $studioJava "bin\java.exe")) {
    return $studioJava
  }

  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
    return $env:JAVA_HOME
  }

  $java = Get-Command java -ErrorAction SilentlyContinue
  if ($java) {
    return $null
  }

  throw "Java not found. Install Android Studio or set JAVA_HOME."
}

function Ensure-Gradle {
  if (Test-Path $GradleBat) {
    return
  }

  New-Item -ItemType Directory -Force $BootstrapDir | Out-Null

  if (-not (Test-Path $GradleZip)) {
    Write-Host "Downloading Gradle $GradleVersion..."
    Invoke-WebRequest -Uri $DistributionUrl -OutFile $GradleZip
  }

  Write-Host "Extracting Gradle $GradleVersion..."
  Expand-Archive -LiteralPath $GradleZip -DestinationPath $BootstrapDir -Force

  if (-not (Test-Path $GradleBat)) {
    throw "Gradle bootstrap failed; expected $GradleBat"
  }
}

function Ensure-LocalProperties($sdkRoot) {
  $escaped = $sdkRoot.Replace("\", "\\")
  Set-Content -LiteralPath (Join-Path $AndroidDir "local.properties") -Value "sdk.dir=$escaped" -Encoding ASCII
}

$sdkRoot = Resolve-AndroidSdk
$javaHome = Resolve-JavaHome
Ensure-Gradle
Ensure-LocalProperties $sdkRoot

$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:GRADLE_USER_HOME = Join-Path $AndroidDir ".gradle-user-home"
if ($javaHome) {
  $env:JAVA_HOME = $javaHome
  $env:PATH = (Join-Path $javaHome "bin") + [IO.Path]::PathSeparator + $env:PATH
}

Write-Host "Android SDK: $sdkRoot"
Write-Host "Gradle: $GradleBat"
if ($javaHome) {
  Write-Host "Java: $javaHome"
}

Push-Location $AndroidDir
try {
  & $GradleBat "--no-daemon" $Task
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}

if ($Task -eq "assembleDebug") {
  $apk = Join-Path $AndroidDir "app\build\outputs\apk\debug\app-debug.apk"
  if (Test-Path $apk) {
    Write-Host "APK: $apk"
  }
}

if ($Task -eq "assembleRelease") {
  $apk = Join-Path $AndroidDir "app\build\outputs\apk\release\app-release.apk"
  if (Test-Path $apk) {
    Write-Host "APK: $apk"
  }
}
