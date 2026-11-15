# ci-quality.ps1 — quality-regression gate for CI (Phase 5 / E2 ROADMAP-IDEAL).
#
# EN: Runs tools/scan2bim-py/run-quality-all.py with the repository baseline,
#     prints the PASS/FAIL table produced by the scanner, then applies the CI policy:
#       * exit 0 — no regressions (and, in strict completeness mode, no SKIPs);
#       * exit 1 — regression vs baseline (or absolute ROADMAP targets with -Targets,
#                  or missing data/clouds without --allow-missing);
#       * exit 2 — environment/config error (python/ruler/baseline/report missing).
# RU (кратко): гейт регрессии качества для CI. По умолчанию проверяется РЕГРЕССИЯ
#     относительно qa\quality-baseline.json; абсолютные пороги ROADMAP включаются
#     ключом --targets. Отсутствующие облака/модели в строгом режиме дают FAIL,
#     а с ключом --allow-missing — SKIP и не роняют прогон (PR без данных).
#
# Usage (Windows PowerShell 5.1+ / pwsh 7+):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 --allow-missing
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 -Root D:\BIM-TWIN-TEST -Targets
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 --python C:\path\python.exe
#
# Options (both `--opt value` and `-Opt value` / `--opt=value` accepted):
#   --python PATH     Python interpreter (default: BIMTWIN_PYTHON env, then the
#                     DSH runtime path, then `python` from PATH)
#   --root PATH       test-data root (default: BIMTWIN_TEST_ROOT env, else D:\BIM-TWIN-TEST)
#   --baseline PATH   regression baseline JSON (default: qa\quality-baseline.json)
#   --report PATH     output JSON of run-quality-all.py (default: qa\quality-runs\quality-all-report.json)
#   --workdir PATH    directory for per-cloud ruler reports/logs (default: qa\quality-runs)
#   --targets         also enforce absolute ROADMAP thresholds (release gate; by default
#                     target FAILs are only shown in the table, the gate tracks regressions)
#   --allow-missing   tolerate missing clouds/models/metrics (they become SKIP, exit 0)
#   --help            show this help
#
# The script never writes the baseline (no --save-baseline): CI must not change the reference.

param()

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- defaults / args
$DefaultPython = 'C:\Users\bob\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$Python = ''
$Root = ''
$Baseline = 'qa\quality-baseline.json'
$Report = 'qa\quality-runs\quality-all-report.json'
$WorkDir = 'qa\quality-runs'
$AllowMissing = $false
$Targets = $false

function Show-Usage {
    Write-Host 'ci-quality.ps1 — quality regression gate for CI (E2, ROADMAP-IDEAL).'
    Write-Host ''
    Write-Host 'Usage:'
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan2bim-py\ci-quality.ps1 [options]'
    Write-Host ''
    Write-Host 'Options:'
    Write-Host '  --python PATH     Python interpreter (default: BIMTWIN_PYTHON, DSH runtime, python)'
    Write-Host '  --root PATH       test-data root (default: BIMTWIN_TEST_ROOT, else D:\BIM-TWIN-TEST)'
    Write-Host '  --baseline PATH   baseline JSON (default: qa\quality-baseline.json)'
    Write-Host '  --report PATH     quality report JSON (default: qa\quality-runs\quality-all-report.json)'
    Write-Host '  --workdir PATH    ruler reports/logs directory (default: qa\quality-runs)'
    Write-Host '  --targets         also enforce absolute ROADMAP thresholds (default: regressions only)'
    Write-Host '  --allow-missing   missing clouds/models/metrics become SKIP instead of FAIL'
    Write-Host '  --help            this help'
    Write-Host ''
    Write-Host 'Exit codes: 0 OK, 1 quality FAIL/regression (or strict SKIP), 2 environment error.'
}

$ErrorArgs = ''
$i = 0
while ($i -lt $args.Count) {
    $a = [string]$args[$i]
    if ($a -eq '--help' -or $a -eq '-h' -or $a -eq '-Help' -or $a -eq 'help') {
        Show-Usage
        exit 0
    }
    elseif ($a -eq '--allow-missing' -or $a -eq '-AllowMissing' -or $a -eq '--allowmissing') {
        $AllowMissing = $true
        $i++
    }
    elseif ($a -eq '--targets' -or $a -eq '-Targets' -or $a -eq '--strict-targets') {
        $Targets = $true
        $i++
    }
    elseif ($a -match '^(--python|-Python)(?:=(.*))?$') {
        if ($matches[2]) { $Python = $matches[2]; $i++ }
        elseif ($i + 1 -lt $args.Count) { $Python = [string]$args[$i + 1]; $i += 2 }
        else { $ErrorArgs = $a }
    }
    elseif ($a -match '^(--root|-Root)(?:=(.*))?$') {
        if ($matches[2]) { $Root = $matches[2]; $i++ }
        elseif ($i + 1 -lt $args.Count) { $Root = [string]$args[$i + 1]; $i += 2 }
        else { $ErrorArgs = $a }
    }
    elseif ($a -match '^(--baseline|-Baseline)(?:=(.*))?$') {
        if ($matches[2]) { $Baseline = $matches[2]; $i++ }
        elseif ($i + 1 -lt $args.Count) { $Baseline = [string]$args[$i + 1]; $i += 2 }
        else { $ErrorArgs = $a }
    }
    elseif ($a -match '^(--report|-Report)(?:=(.*))?$') {
        if ($matches[2]) { $Report = $matches[2]; $i++ }
        elseif ($i + 1 -lt $args.Count) { $Report = [string]$args[$i + 1]; $i += 2 }
        else { $ErrorArgs = $a }
    }
    elseif ($a -match '^(--workdir|-WorkDir)(?:=(.*))?$') {
        if ($matches[2]) { $WorkDir = $matches[2]; $i++ }
        elseif ($i + 1 -lt $args.Count) { $WorkDir = [string]$args[$i + 1]; $i += 2 }
        else { $ErrorArgs = $a }
    }
    else {
        Write-Host ("[ci-quality] ОШИБКА: неизвестный аргумент: {0}" -f $a)
        Write-Host '[ci-quality] подсказка: --allow-missing | --targets | --python PATH | --root PATH | --help'
        exit 2
    }
}
if ($ErrorArgs) {
    Write-Host ("[ci-quality] ОШИБКА: у аргумента {0} нет значения" -f $ErrorArgs)
    exit 2
}

# ---------------------------------------------------------------- paths / env
$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Repo -or -not (Test-Path (Join-Path $Repo 'tools\scan2bim-py\run-quality-all.py'))) {
    Write-Host '[ci-quality] ОШИБКА: не найден корень репозитория (tools\scan2bim-py\run-quality-all.py)'
    exit 2
}

function Resolve-RepoPath([string]$p) {
    if (-not $p) { return $p }
    if ([System.IO.Path]::IsPathRooted($p)) { return $p }
    return (Join-Path $Repo $p)
}

$BaselinePath = Resolve-RepoPath $Baseline
$ReportPath = Resolve-RepoPath $Report
$WorkDirPath = Resolve-RepoPath $WorkDir

if (-not $Python) {
    if ($env:BIMTWIN_PYTHON) { $Python = $env:BIMTWIN_PYTHON }
    elseif (Test-Path $DefaultPython) { $Python = $DefaultPython }
    else { $Python = 'python' }
}
if ($Python -ne 'python' -and -not (Test-Path $Python)) {
    Write-Host ("[ci-quality] ОШИБКА: не найден Python: {0}" -f $Python)
    exit 2
}

if (-not $Root) {
    if ($env:BIMTWIN_TEST_ROOT) { $Root = $env:BIMTWIN_TEST_ROOT }
    else { $Root = 'D:\BIM-TWIN-TEST' }
}

$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
$PrevConsoleEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Write-Host '================================================================================'
Write-Host ' ci-quality.ps1 — quality regression gate (Phase 5 / E2, ROADMAP-IDEAL)'
Write-Host '================================================================================'
Write-Host (" repo:        {0}" -f $Repo)
Write-Host (" python:      {0}" -f $Python)
Write-Host (" data root:   {0}{1}" -f $Root, $(if (Test-Path $Root) { '' } else { '  (НЕТ ДИРЕКТОРИИ)' }))
Write-Host (" baseline:    {0}{1}" -f $BaselinePath, $(if (Test-Path $BaselinePath) { '' } else { '  (НЕТ ФАЙЛА)' }))
Write-Host (" report:      {0}" -f $ReportPath)
Write-Host (" workdir:     {0}" -f $WorkDirPath)
Write-Host (" mode:        {0}; missing data: {1}" -f `
    $(if ($Targets) { 'regression + absolute ROADMAP targets' } else { 'regression only (targets shown, not gated)' }), `
    $(if ($AllowMissing) { 'tolerated (SKIP)' } else { 'STRICT (SKIP = FAIL)' }))
Write-Host ''

if (-not (Test-Path $BaselinePath)) {
    Write-Host ("[ci-quality] ОШИБКА: не найден baseline: {0}" -f $BaselinePath)
    Write-Host '[ci-quality] baseline должен лежать в репозитории (qa\quality-baseline.json) и обновляться осознанно.'
    exit 2
}
$Ruler = Join-Path $Repo 'tools\scan2bim-py\ruler-v2.py'
if (-not (Test-Path $Ruler)) {
    Write-Host ("[ci-quality] ОШИБКА: не найден ruler-v2.py: {0}" -f $Ruler)
    exit 2
}
if (-not (Test-Path $WorkDirPath)) {
    New-Item -ItemType Directory -Force -Path $WorkDirPath | Out-Null
}
$ReportDir = Split-Path -Parent $ReportPath
if ($ReportDir -and -not (Test-Path $ReportDir)) {
    New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
}

# remove stale report so a crashed run cannot be mistaken for a fresh one
if (Test-Path $ReportPath) { Remove-Item $ReportPath -Force }

# ---------------------------------------------------------------- run
$ScanScript = Join-Path $Repo 'tools\scan2bim-py\run-quality-all.py'
$PyArgs = @(
    $ScanScript,
    '--root', $Root,
    '--baseline', $BaselinePath,
    '--json', $ReportPath,
    '--workdir', $WorkDirPath
)

$StdoutLog = Join-Path $WorkDirPath 'ci-quality.stdout.log'
$StderrLog = Join-Path $WorkDirPath 'ci-quality.stderr.log'
$RunLog = Join-Path $WorkDirPath 'ci-quality.log'
if (Test-Path $StdoutLog) { Remove-Item $StdoutLog -Force }
if (Test-Path $StderrLog) { Remove-Item $StderrLog -Force }

Write-Host ("[ci-quality] запуск: {0} {1}" -f $Python, ($PyArgs -join ' '))
$t0 = Get-Date
& $Python @PyArgs > $StdoutLog 2> $StderrLog
$ScriptExit = $LASTEXITCODE
$Elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)

$OutputText = ''
if (Test-Path $StdoutLog) { $OutputText += (Get-Content -Path $StdoutLog -Raw) }
if (Test-Path $StderrLog) {
    $ErrText = Get-Content -Path $StderrLog -Raw
    if ($ErrText) { $OutputText += "`r`n--- stderr ---`r`n" + $ErrText }
}
$OutputText | Out-File -FilePath $RunLog -Encoding UTF8
Write-Host $OutputText
Write-Host ("[ci-quality] run-quality-all.py: код {0}, время {1} с" -f $ScriptExit, $Elapsed)

# ---------------------------------------------------------------- parse report & policy
if (-not (Test-Path $ReportPath)) {
    Write-Host ("[ci-quality] ОШИБКА: run-quality-all.py не создал отчёт: {0}" -f $ReportPath)
    Write-Host ("[ci-quality] код скрипта: {0}; лог: {1}" -f $ScriptExit, $RunLog)
    exit 2
}
try {
    $ReportObj = Get-Content -Path $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    Write-Host ("[ci-quality] ОШИБКА: не удалось разобрать JSON-отчёт: {0}" -f $_.Exception.Message)
    exit 2
}

$Pass = 0; $Fail = 0; $Skip = 0
if ($ReportObj.summary) {
    if ($null -ne $ReportObj.summary.pass) { $Pass = [int]$ReportObj.summary.pass }
    if ($null -ne $ReportObj.summary.fail) { $Fail = [int]$ReportObj.summary.fail }
    if ($null -ne $ReportObj.summary.skip) { $Skip = [int]$ReportObj.summary.skip }
}
$RunErrors = @()
if ($ReportObj.errors) { $RunErrors = @($ReportObj.errors) }
$Warnings = @()
if ($ReportObj.warnings) { $Warnings = @($ReportObj.warnings) }

$RegFails = @()
$TargetFails = @()
$HistoricFails = @()
$EntryRows = @()
foreach ($entry in @($ReportObj.entries)) {
    if ($null -eq $entry) { continue }
    $s = @{ PASS = 0; FAIL = 0; SKIP = 0; INFO = 0 }
    foreach ($chk in @($entry.checks)) {
        if ($null -eq $chk) { continue }
        if ($s.ContainsKey([string]$chk.status)) { $s[[string]$chk.status] = $s[[string]$chk.status] + 1 }
        if ($chk.status -eq 'FAIL') {
            $line = ("{0} :: {1} [{2}] — {3}" -f $entry.name, $chk.label, $chk.code, $chk.detail)
            if ($chk.code -eq 'REG') { $RegFails += $line }
            elseif ([string]$entry.role -eq 'baseline') { $HistoricFails += $line }
            else { $TargetFails += $line }
        }
    }
    $EntryRows += [pscustomobject]@{
        Entry   = [string]$entry.name
        Kind    = [string]$entry.kind
        Status  = [string]$entry.status
        PASS    = $s['PASS']
        FAIL    = $s['FAIL']
        SKIP    = $s['SKIP']
        INFO    = $s['INFO']
    }
}

Write-Host ''
Write-Host '=== СВОДКА CI-ГЕЙТА ==='
$EntryRows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
Write-Host (" проверок: PASS {0} | FAIL {1} | SKIP {2}" -f $Pass, $Fail, $Skip)
Write-Host (" регрессии (REG): {0} | целевые FAIL: {1} | исторические FAIL: {2} | ошибок прогона: {3}" -f $RegFails.Count, $TargetFails.Count, $HistoricFails.Count, $RunErrors.Count)
if ($RegFails.Count -gt 0) {
    Write-Host ' --- регрессии относительно baseline ---'
    foreach ($r in $RegFails) { Write-Host ("  [REG] {0}" -f $r) }
}
if ($TargetFails.Count -gt 0) {
    Write-Host ' --- целевые пороги ROADMAP не выполнены (в таблице выше) ---'
    foreach ($r in $TargetFails) { Write-Host ("  [TARGET] {0}" -f $r) }
}
if ($HistoricFails.Count -gt 0) {
    Write-Host ' --- исторические (эталонная модель r107): целевые FAIL не гейтятся ---'
    foreach ($r in $HistoricFails) { Write-Host ("  [HISTORY] {0}" -f $r) }
}
if ($Warnings.Count -gt 0) {
    Write-Host (" предупреждения: {0}" -f $Warnings.Count)
    foreach ($w in $Warnings) { Write-Host ("  [WARN] {0}" -f $w) }
}
foreach ($e in $RunErrors) { Write-Host ("  [ERROR] {0}" -f $e) }
Write-Host (" артефакты: отчёт {0}; лог {1}; ruler-JSON в {2}" -f $ReportPath, $RunLog, $WorkDirPath)

# ---------------------------------------------------------------- decide exit code
$ExitCode = 0
$Reasons = @()
if ($RunErrors.Count -gt 0) {
    $ExitCode = 2
    $Reasons += ("ошибки прогона: {0}" -f $RunErrors.Count)
}
elseif ($RegFails.Count -gt 0) {
    $ExitCode = 1
    $Reasons += ("регрессия относительно baseline: {0}" -f $RegFails.Count)
}
elseif ($Targets -and $TargetFails.Count -gt 0) {
    $ExitCode = 1
    $Reasons += ("целевые пороги ROADMAP не выполнены: {0} (режим --targets)" -f $TargetFails.Count)
}
elseif ((-not $AllowMissing) -and $Skip -gt 0) {
    $ExitCode = 1
    $Reasons += ("строгий режим: {0} SKIP — отсутствуют облака/модели/метрики; используйте --allow-missing для PR без данных" -f $Skip)
}

if ($ExitCode -eq 0) {
    if ($TargetFails.Count -gt 0) {
        Write-Host (" ИТОГ: OK (0) — регрессий нет; известных целевых FAIL {0} (гейт отслеживает регресс, не абсолютные пороги)" -f $TargetFails.Count)
    } else {
        Write-Host ' ИТОГ: OK (0)'
    }
}
elseif ($ExitCode -eq 1) {
    Write-Host (" ИТОГ: FAIL (1) — {0}" -f ($Reasons -join '; '))
}
else {
    Write-Host (" ИТОГ: ОШИБКА (2) — {0}" -f ($Reasons -join '; '))
}
try { [Console]::OutputEncoding = $PrevConsoleEnc } catch { }
exit $ExitCode
