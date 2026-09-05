param(
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env")
)

$ErrorActionPreference = "Stop"

function Set-EnvValue {
  param([string]$Path, [string]$Name, [string]$Value)
  $content = if (Test-Path $Path) { Get-Content $Path -Raw } else { "" }
  $escapedName = [Regex]::Escape($Name)
  $line = "$Name=$Value"
  if ($content -match "(?m)^$escapedName=.*$") {
    $content = [Regex]::Replace($content, "(?m)^$escapedName=.*$", [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $line })
  } else {
    if ($content -and -not $content.EndsWith("`n")) { $content += "`r`n" }
    $content += "$line`r`n"
  }
  Set-Content -Path $Path -Value $content -NoNewline -Encoding UTF8
}

Write-Host ""
Write-Host "Cherry POS - Ollama Cloud Setup" -ForegroundColor Cyan
Write-Host "The API key will be stored only in backend .env and will not be printed." -ForegroundColor DarkGray
Write-Host ""

$secure = Read-Host "Paste your NEW Ollama API key" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw "API key cannot be blank."
}

Set-EnvValue $EnvFile "OLLAMA_BASE_URL" "https://ollama.com"
Set-EnvValue $EnvFile "OLLAMA_API_KEY" $apiKey
Set-EnvValue $EnvFile "OLLAMA_MODEL" "gpt-oss:20b-cloud"
Set-EnvValue $EnvFile "OLLAMA_MODEL_CANDIDATES" "gpt-oss:20b-cloud,gpt-oss:20b,nemotron-3-nano:30b-cloud,nemotron-3-nano,qwen3.5:cloud,qwen3.5,deepseek-v4-flash:cloud,deepseek-v4-flash,deepseek-v4-pro"
Set-EnvValue $EnvFile "OLLAMA_FALLBACK_MODELS" "gpt-oss:20b,nemotron-3-nano:30b-cloud,nemotron-3-nano,qwen3.5:cloud,qwen3.5,deepseek-v4-flash:cloud,deepseek-v4-flash,deepseek-v4-pro"
Set-EnvValue $EnvFile "OLLAMA_MODEL_ACCESS_COOLDOWN_MS" "300000"
Set-EnvValue $EnvFile "OLLAMA_TIMEOUT_MS" "120000"
Set-EnvValue $EnvFile "OLLAMA_NUM_CTX" "16384"
Set-EnvValue $EnvFile "OLLAMA_NUM_PREDICT" "4096"
Set-EnvValue $EnvFile "OLLAMA_THINKING" "low"
Set-EnvValue $EnvFile "OLLAMA_PLANNER_THINK_LEVEL" "medium"
Set-EnvValue $EnvFile "OLLAMA_COMPLEX_THINK_LEVEL" "high"
Set-EnvValue $EnvFile "OLLAMA_MAX_THINKING" "false"

Write-Host "Backend .env updated." -ForegroundColor Green
Write-Host "Testing Ollama Cloud and selecting the best model currently allowed by this account..." -ForegroundColor Cyan

$headers = @{
  Authorization = "Bearer $apiKey"
  "Content-Type" = "application/json"
}

$candidates = @(
  "gpt-oss:20b-cloud",
  "gpt-oss:20b",
  "nemotron-3-nano:30b-cloud",
  "nemotron-3-nano",
  "qwen3.5:cloud",
  "qwen3.5",
  "deepseek-v4-flash:cloud",
  "deepseek-v4-flash",
  "deepseek-v4-pro"
)

$workingModel = $null
$lastError = $null
foreach ($model in $candidates) {
  try {
    $body = @{
      model = $model
      messages = @(@{ role = "user"; content = "Reply only with: CLOUD_OK" })
      stream = $false
      think = $false
      options = @{ num_predict = 16; temperature = 0 }
    } | ConvertTo-Json -Depth 8

    $result = Invoke-RestMethod -Uri "https://ollama.com/api/chat" -Method POST -Headers $headers -Body $body -TimeoutSec 120
    if ($result.message.content -match "CLOUD_OK") {
      $workingModel = $model
      break
    }
  } catch {
    $lastError = $_.Exception.Message
  }
}

$apiKey = $null

if (-not $workingModel) {
  Write-Host "Cloud setup was saved, but none of the configured models is currently accessible on this Ollama account." -ForegroundColor Yellow
  if ($lastError) { Write-Host "Last error: $lastError" -ForegroundColor Yellow }
  Write-Host "Either add Ollama usage/upgrade, or run: npm run test:ollama-cloud after your plan/credits change." -ForegroundColor Yellow
  exit 1
}

Set-EnvValue $EnvFile "OLLAMA_MODEL" $workingModel
Write-Host ""
Write-Host "SUCCESS: Ollama Cloud is working." -ForegroundColor Green
Write-Host "Working model: $workingModel" -ForegroundColor Green
Write-Host "Now restart the Node backend." -ForegroundColor Cyan
