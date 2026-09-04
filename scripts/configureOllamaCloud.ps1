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
Set-EnvValue $EnvFile "OLLAMA_MODEL" "deepseek-v4-pro"
Set-EnvValue $EnvFile "OLLAMA_MODEL_CANDIDATES" "deepseek-v4-pro,deepseek-v4-pro:0813,deepseek-v4-pro:cloud,deepseek-v4-pro:0813-cloud"
Set-EnvValue $EnvFile "OLLAMA_TIMEOUT_MS" "120000"
Set-EnvValue $EnvFile "OLLAMA_NUM_CTX" "16384"
Set-EnvValue $EnvFile "OLLAMA_NUM_PREDICT" "4096"
Set-EnvValue $EnvFile "OLLAMA_THINKING" "false"
Set-EnvValue $EnvFile "OLLAMA_PLANNER_THINK_LEVEL" "medium"
Set-EnvValue $EnvFile "OLLAMA_COMPLEX_THINK_LEVEL" "high"
Set-EnvValue $EnvFile "OLLAMA_MAX_THINKING" "false"

Write-Host "Backend .env updated." -ForegroundColor Green
Write-Host "Testing Ollama Cloud and selecting a working DeepSeek model alias..." -ForegroundColor Cyan

$headers = @{
  Authorization = "Bearer $apiKey"
  "Content-Type" = "application/json"
}

$candidates = @(
  "deepseek-v4-pro",
  "deepseek-v4-pro:0813",
  "deepseek-v4-pro:cloud",
  "deepseek-v4-pro:0813-cloud"
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
  Write-Host "Cloud setup was saved, but the live test did not succeed." -ForegroundColor Yellow
  if ($lastError) { Write-Host "Last error: $lastError" -ForegroundColor Yellow }
  Write-Host "Run: npm run test:ollama-cloud" -ForegroundColor Yellow
  exit 1
}

Set-EnvValue $EnvFile "OLLAMA_MODEL" $workingModel
Write-Host ""
Write-Host "SUCCESS: Ollama Cloud is working." -ForegroundColor Green
Write-Host "Working model: $workingModel" -ForegroundColor Green
Write-Host "Now restart the Node backend." -ForegroundColor Cyan
