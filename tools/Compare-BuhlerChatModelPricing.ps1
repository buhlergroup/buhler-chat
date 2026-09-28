#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Compares the MODEL_CONFIGS pricing in buhler-chat's models.ts against the
    Azure Retail Prices API and optionally the Foundry OpenAI-compatible
    /models endpoint, reporting any discrepancies.

.DESCRIPTION
    This script performs three tasks:

    1. PRICE COMPARISON — Parses the MODEL_CONFIGS table from models.ts and
       queries the Azure Retail Prices API (prices.azure.com) for each model
       that has a matching meter. Reports differences between the code's
       hardcoded prices and the API's published rates.

    2. FOUNDRY MODEL LIST — Optionally queries the Foundry OpenAI-compatible
       /models endpoint to list available models and their IDs, which can be
       cross-referenced against the deployment names in models.ts.

    3. DESCRIPTION LOOKUP — Optionally fetches model descriptions from the
       Foundry endpoint (OpenAI-compatible /models returns id, object, and
       created timestamp; some Foundry deployments also serve description).

    The script is designed to be run from the buhler-chat repo root.

.PARAMETER ModelsTsPath
    Path to models.ts. Defaults to
    'src/features/chat-page/chat-services/models.ts' relative to the repo root.

.PARAMETER Region
    Azure region for Retail Prices API lookup. Defaults to 'swedencentral'.

.PARAMETER DeploymentType
    Deployment type filter for Retail Prices API. Defaults to 'Global'.
    Valid: Global, DataZone, Regional.

.PARAMETER FoundryBaseUrl
    Foundry OpenAI-compatible base URL (e.g.
    https://<resource>.services.ai.azure.com/openai/v1).
    When provided, the script also queries the Foundry /models endpoint.

.PARAMETER FoundryApiKey
    API key for the Foundry endpoint. Required when -FoundryBaseUrl is set.

.PARAMETER IncludeFoundryModels
    When set, also queries the Foundry OpenAI-compatible /models endpoint to
    list available model IDs and cross-reference them against the deployment
    names in models.ts. Requires -FoundryBaseUrl and -FoundryApiKey.

.PARAMETER IncludeDescriptions
    When set alongside -IncludeFoundryModels, also fetches model descriptions
    from the Foundry management API (Azure AI Foundry SDK /model_registry).
    Requires -FoundryBaseUrl and -FoundryApiKey.

.PARAMETER IncludeAnthropic
    When set, also checks Anthropic's published pricing for Claude models
    (claude-opus-5-5, claude-opus-4-8, claude-sonnet-5) against the code.
    Requires no API key — uses Anthropic's published list prices.

.PARAMETER SkipExchangeRate
    When set, skips USD → CHF exchange rate lookup.

.PARAMETER OutputFormat
    Output format: 'Table' (default), 'Json', or 'Csv'.

.EXAMPLE
    # Basic price comparison against Azure Retail Prices API
    ./tools/Compare-BuhlerChatModelPricing.ps1

.EXAMPLE
    # Include Foundry model list and Anthropic price check
    ./tools/Compare-BuhlerChatModelPricing.ps1 `
        -FoundryBaseUrl $env:FOUNDRY_OPENAI_BASE_URL `
        -FoundryApiKey $env:FOUNDRY_API_KEY `
        -IncludeFoundryModels -IncludeAnthropic

.EXAMPLE
    # Output as JSON for programmatic consumption
    ./tools/Compare-BuhlerChatModelPricing.ps1 -OutputFormat Json

.NOTES
    Author: Copilot-generated for buhler-chat finops
    Source: https://github.com/buhler/buhler-chat
#>

[CmdletBinding()]
[OutputType([PSCustomObject])]
param(
    [Parameter()]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$ModelsTsPath = (Join-Path $PSScriptRoot '..' 'src' 'features' 'chat-page' 'chat-services' 'models.ts'),

    [Parameter()]
    [string]$Region = 'swedencentral',

    [Parameter()]
    [ValidateSet('Global', 'DataZone', 'Regional')]
    [string]$DeploymentType = 'Global',

    [Parameter()]
    [string]$FoundryBaseUrl,

    [Parameter()]
    [string]$FoundryApiKey,

    [Parameter()]
    [switch]$IncludeFoundryModels,

    [Parameter()]
    [switch]$IncludeDescriptions,

    [Parameter()]
    [switch]$IncludeAnthropic,

    [Parameter()]
    [switch]$SkipExchangeRate,

    [Parameter()]
    [switch]$VerboseOutput,

    [Parameter()]
    [ValidateSet('Table', 'Json', 'Csv')]
    [string]$OutputFormat = 'Table'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Debug helper ───────────────────────────────────────────────────────────
function Write-DebugInfo {
    param([string]$m)
    if ($VerboseOutput) { Write-Host "  🔍 $m" -ForegroundColor DarkGray }
}

# ── Helper: colourised Write-Host wrappers ─────────────────────────────────
function Write-Success { param([string]$m) Write-Host "✓ $m" -ForegroundColor Green }
function Write-Warn    { param([string]$m) Write-Host "⚠ $m" -ForegroundColor Yellow }
function Write-Error   { param([string]$m) Write-Host "✗ $m" -ForegroundColor Red }
function Write-Info    { param([string]$m) Write-Host "ℹ $m" -ForegroundColor Cyan }
function Write-Diff    { param([string]$m) Write-Host "Δ $m" -ForegroundColor Magenta }

# ═══════════════════════════════════════════════════════════════════════════
# STEP 1 — Parse MODEL_CONFIGS from models.ts
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "`n══════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  Compare-BuhlerChatModelPricing" -ForegroundColor White
Write-Host "══════════════════════════════════════════════════════════════`n" -ForegroundColor White

Write-Info "Parsing MODEL_CONFIGS from: $ModelsTsPath"

if (-not (Test-Path $ModelsTsPath)) {
    Write-Error "File not found: $ModelsTsPath"
    exit 1
}

$tsContent = Get-Content $ModelsTsPath -Raw

# Extract the MODEL_CONFIGS record block — from "export const MODEL_CONFIGS" to the closing "};"
$configMatch = [regex]::Match($tsContent, '(?s)export\s+const\s+MODEL_CONFIGS\s*:\s*Record<ChatModel,\s*ModelConfig>\s*=\s*\{(.*?)\};\s*(?:\n|$)(?!\s*\})')
if (-not $configMatch.Success) {
    Write-Error 'Could not locate MODEL_CONFIGS in models.ts'
    exit 1
}

$configBlock = $configMatch.Groups[1].Value

# Parse each model entry: `"model-id": { ... },`
$modelEntries = [System.Collections.Generic.List[PSCustomObject]]::new()
$entryRegex = [regex]'(?ms)"([^"]+)"\s*:\s*\{'

$entryStarts = [System.Collections.ArrayList]::new()
$idx = 0
foreach ($m in $entryRegex.Matches($configBlock)) {
    $null = $entryStarts.Add(@{ Id = $m.Groups[1].Value; Index = $m.Index })
}

for ($i = 0; $i -lt $entryStarts.Count; $i++) {
    $start = $entryStarts[$i]
    $endIndex = if ($i + 1 -lt $entryStarts.Count) { $entryStarts[$i + 1].Index } else { $configBlock.Length }
    $entryBody = $configBlock.Substring($start.Index, $endIndex - $start.Index)

    # Extract pricing block
    $pricingMatch = [regex]::Match($entryBody, '(?s)pricing\s*:\s*\{(.*?)\}')
    if (-not $pricingMatch.Success) { continue }

    $pricingText = $pricingMatch.Groups[1].Value

    # Extract individual price fields
    $inp = [regex]::Match($pricingText, 'inputPerMillion\s*:\s*([\d.]+)')
    $out = [regex]::Match($pricingText, 'outputPerMillion\s*:\s*([\d.]+)')
    $cac = [regex]::Match($pricingText, 'cachedInputPerMillion\s*:\s*([\d.]+)')
    $wrt = [regex]::Match($pricingText, 'cacheWritePerMillion\s*:\s*([\d.]+)')
    $plc = [regex]::Match($pricingText, 'priceLastCheckedUtc\s*:\s*"([^"]+)"')

    # Extract provider, family, description, deploymentName
    $prov = [regex]::Match($entryBody, 'provider\s*:\s*"([^"]+)"')
    $fam  = [regex]::Match($entryBody, 'family\s*:\s*"([^"]+)"')
    $desc = [regex]::Match($entryBody, 'description\s*:\s*"([^"]+)"')
    $dep  = [regex]::Match($entryBody, 'deploymentName\s*:\s*process\.env\.([A-Z_]+)')

    $modelEntry = [PSCustomObject]@{
        Id                   = $start.Id
        Provider             = if ($prov.Success) { $prov.Groups[1].Value } else { 'azure' }
        Family               = if ($fam.Success) { $fam.Groups[1].Value } else { '' }
        Description          = if ($desc.Success) { $desc.Groups[1].Value } else { '' }
        DeploymentEnvVar     = if ($dep.Success) { $dep.Groups[1].Value } else { '' }
        InputPerMillion      = if ($inp.Success) { [double]$inp.Groups[1].Value } else { 0 }
        OutputPerMillion     = if ($out.Success) { [double]$out.Groups[1].Value } else { 0 }
        CachedPerMillion     = if ($cac.Success) { [double]$cac.Groups[1].Value } else { 0 }
        CacheWritePerMillion = if ($wrt.Success) { [double]$wrt.Groups[1].Value } else { $null }
        PriceLastCheckedUtc  = if ($plc.Success) { $plc.Groups[1].Value } else { $null }
    }
    $modelEntries.Add($modelEntry)
}

Write-Success "Parsed $($modelEntries.Count) model configs from models.ts"
Write-Host ""

if ($VerboseOutput) {
    Write-DebugInfo "Models with priceLastCheckedUtc:"
    foreach ($me in $modelEntries) {
        $plc = if ($me.PriceLastCheckedUtc) { $me.PriceLastCheckedUtc } else { '(missing)' }
        Write-DebugInfo "  $($me.Id): $plc"
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# STEP 2 — Query Azure Retail Prices API
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "── Step 2: Querying Azure Retail Prices API ──────────────────" -ForegroundColor White
Write-Info "Region: $Region | Deployment type: $DeploymentType"

# Build a combined OData filter for all Azure/Foundry models
$azureModels = $modelEntries | Where-Object { $_.Provider -in 'azure', 'foundry' }
$retailResults = [System.Collections.Generic.List[PSCustomObject]]::new()
$diffResults = [System.Collections.Generic.List[PSCustomObject]]::new()

# We query the API per-model to keep the filter manageable
function ConvertTo-PerMillionPrice {
    param([object]$Item)
    $price = [double]$Item.retailPrice
    switch -Wildcard ($Item.unitOfMeasure) {
        '1 K*' { return $price * 1000 }
        '1K*' { return $price * 1000 }
        '1000*' { return $price }
        '1 M*' { return $price }
        '1M*' { return $price }
        default { return $price }
    }
}

$deployPattern = switch ($DeploymentType) {
    'Global' { '(?i)\b(glbl|Glbl|global|Gl|DZone|Dz|Data\s+Zone)\b' }
    'DataZone' { '(?i)(\bDZone\b|\bDz\b|Data\s+Zone)' }
    'Regional' { '(?i)\b(regnl|regional)\b' }
}

function Extract-ModelNameFromSku {
    param([string]$Sku)
    $m = [regex]::Match($Sku, '^(.*?)[\s-]+(?:(?:Cached|cchd|cd)[\s-]+)?(?i)(?:Inp|Inpt|Outp|outpt|input|output|opt|Batch)\b')
    if ($m.Success) { return $m.Groups[1].Value.Trim('- ') }
    return $Sku
}

# Map model IDs to Retail API meter-name search terms.
# The Azure Retail Prices API uses short names like '5.6 sol', '6 luna', '5.4 mini'
# rather than the full model IDs like 'gpt-5.6-sol' or 'gpt-6-luna'.
$modelSearchTerms = @{
    'gpt-6-sol'       = @('6 sol', '6-sol')
    'gpt-6-luna'      = @('6 luna', '6-luna')
    'gpt-5.6-sol'     = @('5.6 sol', '5.6-sol')
    'gpt-5.6-terra'   = @('5.6 terra', '5.6-terra')
    'gpt-5.6-luna'    = @('5.6 luna', '5.6-luna')
    'gpt-5.5'         = @('5.5 ShortCo', '5.5 LongCo', 'gpt-5.5')
    'gpt-5.4'         = @('5.4 inp', '5.4 opt', '5.4 cd')
    'gpt-5.4-mini'    = @('5.4 mini inp', '5.4 mini opt', '5.4 mini cd')
    'DeepSeek-V4-Pro' = @('DeepSeek-V4-Pro', 'DeepSeek V4 Pro', 'FW DeepSeek')
    'Kimi-K2.6'       = @('Kimi K2.6', 'Kimi-K2.6', 'FW Kimi')
    'grok-4.3'        = @('Grok 4', 'Grok-4', 'FW Grok')
}

foreach ($model in $azureModels) {
    $searchTerms = $modelSearchTerms[$model.Id]
    if (-not $searchTerms) {
        $searchTerms = @($model.Id, ($model.Id -replace '-', ' '))
    }

    # Build OR filter from all search terms.
    # OData `contains` IS case-sensitive, so keep the original casing.
    $termFilters = $searchTerms | ForEach-Object {
        $dashTerm = $_
        $spaceTerm = $dashTerm -replace '-', ' '
        if ($spaceTerm -ne $dashTerm) {
            "(contains(meterName, '$dashTerm') or contains(meterName, '$spaceTerm'))"
        } else {
            "contains(meterName, '$dashTerm')"
        }
    }
    $meterFilter = $termFilters -join ' or '
    $oDataFilter = "serviceName eq 'Foundry Models' and priceType eq 'Consumption' and armRegionName eq '$Region' and ($meterFilter)"
    $encodedFilter = [uri]::EscapeDataString($oDataFilter)
    $url = "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview&`$filter=$encodedFilter"

    if ($VerboseOutput) { Write-DebugInfo "Querying Retail API for '$($model.Id)' with search terms: $($searchTerms -join ', ')" }

    try {
        $resp = Invoke-RestMethod -Uri $url -Method Get -ErrorAction Stop
    } catch {
        Write-Warn "Retail API query failed for '$($model.Id)': $_"
        continue
    }

    $items = @($resp.Items)
    if ($VerboseOutput) { Write-DebugInfo "  Raw API returned $($items.Count) items" }
    if ($items.Count -eq 0) {
        Write-Warn "No retail pricing data for '$($model.Id)' in region '$Region'"
        continue
    }

    # Filter to token-priced items for the requested deployment type
    $tokenItems = @($items | Where-Object {
        $_.unitOfMeasure -match '^1\s*[KM]' -and $_.meterName -match $deployPattern
    })

    if ($VerboseOutput) { Write-DebugInfo "  After deployment-type filter: $($tokenItems.Count) items" }
    if ($tokenItems.Count -eq 0) {
        Write-Warn "No token-priced items for '$($model.Id)' / $DeploymentType"
        if ($VerboseOutput) {
            Write-DebugInfo "  Available meter names (first 10):"
            $items | Select-Object -First 10 -ExpandProperty meterName | ForEach-Object { Write-DebugInfo "    $_" }
        }
        continue
    }

    # Narrow to exact model name match by extracting model from skuName.
    # The skuName uses short names like '5.4 inp Gl' while model IDs are
    # 'gpt-5.4'. Match against both the full model ID and the search terms.
    $normModel = $model.Id.ToLower() -replace '[\s-]+', '-'
    $normTerms = $searchTerms | ForEach-Object { $_.ToLower() -replace '[\s-]+', '-' }
    $exactPattern = '^(.*?)[\s-]+(?:(?:Cached|cchd|cd)[\s-]+)?(?i)(?:Inp|Inpt|Outp|outpt|input|output|opt|Batch)\b'
    $exactItems = @($tokenItems | Where-Object {
        $m = [regex]::Match($_.skuName, $exactPattern)
        if ($m.Success) {
            $extracted = $m.Groups[1].Value.Trim(' -').ToLower() -replace '[\s-]+', '-'
            $extracted -eq $normModel -or $extracted -in $normTerms
        }
        else { $false }
    })
    if ($exactItems.Count -gt 0) {
        if ($VerboseOutput) { Write-DebugInfo "  After exact-name filter: $($exactItems.Count) items (from $($tokenItems.Count))"; $tokenItems = $exactItems }
        else { $tokenItems = $exactItems }
    } elseif ($VerboseOutput) { Write-DebugInfo "  Exact-name filter matched 0 items — using all $($tokenItems.Count) token items" }

    # Classify
    $inputItem = $tokenItems | Where-Object { $_.meterName -match '(?i)\b(Inp|Inpt|input)\b' -and $_.meterName -notmatch '(?i)\b(cached|cache|cchd|cd|cd[\s-]+wr)\b' } |
        Sort-Object retailPrice | Select-Object -First 1
    $cachedItem = $tokenItems | Where-Object { $_.meterName -match '(?i)\b(cached|cache|cchd|cd)\b' -and $_.meterName -notmatch '(?i)\bcd[\s-]+wr\b' } |
        Sort-Object retailPrice | Select-Object -First 1
    $outputItem = $tokenItems | Where-Object { $_.meterName -match '(?i)\b(Outp|outpt|output|opt)\b' } |
        Sort-Object retailPrice | Select-Object -First 1
    $cacheWriteItem = $tokenItems | Where-Object { $_.meterName -match '(?i)\bcd[\s-]+wr\b' } |
        Sort-Object retailPrice | Select-Object -First 1

    if ($VerboseOutput) {
        Write-DebugInfo "  Classified meters:"
        Write-DebugInfo "    Input:      $($inputItem | Select-Object -ExpandProperty meterName -ErrorAction SilentlyContinue) → $($inputItem | Select-Object -ExpandProperty retailPrice -ErrorAction SilentlyContinue)"
        Write-DebugInfo "    Cached:     $($cachedItem | Select-Object -ExpandProperty meterName -ErrorAction SilentlyContinue) → $($cachedItem | Select-Object -ExpandProperty retailPrice -ErrorAction SilentlyContinue)"
        Write-DebugInfo "    Output:     $($outputItem | Select-Object -ExpandProperty meterName -ErrorAction SilentlyContinue) → $($outputItem | Select-Object -ExpandProperty retailPrice -ErrorAction SilentlyContinue)"
        Write-DebugInfo "    CacheWrite: $($cacheWriteItem | Select-Object -ExpandProperty meterName -ErrorAction SilentlyContinue) → $($cacheWriteItem | Select-Object -ExpandProperty retailPrice -ErrorAction SilentlyContinue)"
    }

    $apiInput = if ($inputItem) { [Math]::Round((ConvertTo-PerMillionPrice -Item $inputItem), 4) } else { $null }
    $apiCached = if ($cachedItem) { [Math]::Round((ConvertTo-PerMillionPrice -Item $cachedItem), 4) } else { $null }
    $apiOutput = if ($outputItem) { [Math]::Round((ConvertTo-PerMillionPrice -Item $outputItem), 4) } else { $null }
    $apiCacheWrite = if ($cacheWriteItem) { [Math]::Round((ConvertTo-PerMillionPrice -Item $cacheWriteItem), 4) } else { $null }

    $retailResults.Add([PSCustomObject]@{
        ModelId             = $model.Id
        ApiInput            = $apiInput
        ApiCached           = $apiCached
        ApiOutput           = $apiOutput
        ApiCacheWrite       = $apiCacheWrite
        CodeInput           = $model.InputPerMillion
        CodeCached          = $model.CachedPerMillion
        CodeOutput          = $model.OutputPerMillion
        CodeCacheWrite      = $model.CacheWritePerMillion
        PriceLastCheckedUtc = $model.PriceLastCheckedUtc
        MeterNames          = ($tokenItems | Select-Object -ExpandProperty meterName -Unique) -join '; '
        SkuNames            = ($tokenItems | Select-Object -ExpandProperty skuName -Unique) -join '; '
    })

    # Compare
    $hasDiff = $false
    $diffInput = $null
    $diffCached = $null
    $diffOutput = $null
    $diffCacheWrite = $null

    if ($apiInput -and [Math]::Abs($apiInput - $model.InputPerMillion) -gt 0.001) {
        $hasDiff = $true
        $diffInput = $apiInput - $model.InputPerMillion
    }
    if ($apiCached -and [Math]::Abs($apiCached - $model.CachedPerMillion) -gt 0.001) {
        $hasDiff = $true
        $diffCached = $apiCached - $model.CachedPerMillion
    }
    if ($apiOutput -and [Math]::Abs($apiOutput - $model.OutputPerMillion) -gt 0.001) {
        $hasDiff = $true
        $diffOutput = $apiOutput - $model.OutputPerMillion
    }
    $codeWrt = $model.CacheWritePerMillion
    if ($apiCacheWrite -and $null -ne $codeWrt -and [Math]::Abs($apiCacheWrite - $codeWrt) -gt 0.001) {
        $hasDiff = $true
        $diffCacheWrite = $apiCacheWrite - $codeWrt
    }

    if ($hasDiff) {
        $diffResults.Add([PSCustomObject]@{
            ModelId          = $model.Id
            Provider         = $model.Provider
            Family           = $model.Family
            Description      = $model.Description
            CodeInput        = $model.InputPerMillion
            ApiInput         = $apiInput
            DiffInput        = $diffInput
            CodeCached       = $model.CachedPerMillion
            ApiCached        = $apiCached
            DiffCached       = $diffCached
            CodeOutput       = $model.OutputPerMillion
            ApiOutput        = $apiOutput
            DiffOutput       = $diffOutput
            CodeCacheWrite   = $codeWrt
            ApiCacheWrite    = $apiCacheWrite
            DiffCacheWrite   = $diffCacheWrite
        })
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# STEP 3 — Anthropic price check (published list prices)
# ═══════════════════════════════════════════════════════════════════════════
if ($IncludeAnthropic) {
    Write-Host "`n── Step 3: Checking Anthropic published pricing ──────────────" -ForegroundColor White

    # Anthropic published list prices as of 2026-09-28
    # Source: https://platform.claude.com/docs/en/about-claude/pricing
    $anthropicPublished = @{
        'claude-opus-5-5' = @{ In = 4.0; Out = 20.0; Cac = 0.2; Wrt = 5.0 }
        'claude-opus-4-8' = @{ In = 5.0; Out = 25.0; Cac = 0.5; Wrt = 6.25 }
        'claude-sonnet-5' = @{ In = 3.0; Out = 15.0; Cac = 0.3; Wrt = 3.75 }
    }

    foreach ($model in $modelEntries | Where-Object { $_.Provider -eq 'anthropic' }) {
        $pub = $anthropicPublished[$model.Id]
        if (-not $pub) {
            Write-Warn "No published pricing reference for '$($model.Id)'"
            continue
        }

        $diffs = [System.Collections.Generic.List[string]]::new()
        if ([Math]::Abs($pub.In - $model.InputPerMillion) -gt 0.001) {
            $diffs.Add("input: code=$($model.InputPerMillion) vs published=$($pub.In) (Δ $([Math]::Round($pub.In - $model.InputPerMillion, 4)))")
        }
        if ([Math]::Abs($pub.Out - $model.OutputPerMillion) -gt 0.001) {
            $diffs.Add("output: code=$($model.OutputPerMillion) vs published=$($pub.Out) (Δ $([Math]::Round($pub.Out - $model.OutputPerMillion, 4)))")
        }
        if ([Math]::Abs($pub.Cac - $model.CachedPerMillion) -gt 0.001) {
            $diffs.Add("cached: code=$($model.CachedPerMillion) vs published=$($pub.Cac) (Δ $([Math]::Round($pub.Cac - $model.CachedPerMillion, 4)))")
        }
        $codeWrt = $model.CacheWritePerMillion
        if ($null -ne $codeWrt -and [Math]::Abs($pub.Wrt - $codeWrt) -gt 0.001) {
            $diffs.Add("cacheWrite: code=$codeWrt vs published=$($pub.Wrt) (Δ $([Math]::Round($pub.Wrt - $codeWrt, 4)))")
        }

        if ($diffs.Count -gt 0) {
            Write-Diff "$($model.Id):"
            $diffs | ForEach-Object { Write-Host "         $_" -ForegroundColor Magenta }
            $diffResults.Add([PSCustomObject]@{
                ModelId          = $model.Id
                Provider         = $model.Provider
                Family           = $model.Family
                Description      = $model.Description
                CodeInput        = $model.InputPerMillion
                ApiInput         = $pub.In
                DiffInput        = [Math]::Round($pub.In - $model.InputPerMillion, 4)
                CodeCached       = $model.CachedPerMillion
                ApiCached        = $pub.Cac
                DiffCached       = [Math]::Round($pub.Cac - $model.CachedPerMillion, 4)
                CodeOutput       = $model.OutputPerMillion
                ApiOutput        = $pub.Out
                DiffOutput       = [Math]::Round($pub.Out - $model.OutputPerMillion, 4)
                CodeCacheWrite   = $model.CacheWritePerMillion
            })
        } else {
            Write-Success "$($model.Id): prices match published list prices"
        }
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# STEP 4 — Foundry model list and descriptions
# ═══════════════════════════════════════════════════════════════════════════
if ($IncludeFoundryModels -and $FoundryBaseUrl -and $FoundryApiKey) {
    Write-Host "`n── Step 4: Querying Foundry /models endpoint ─────────────────" -ForegroundColor White

    $modelsUrl = "$FoundryBaseUrl/models"
    $headers = @{ 'api-key' = $FoundryApiKey }

    try {
        $foundryResp = Invoke-RestMethod -Uri $modelsUrl -Method Get -Headers $headers -ErrorAction Stop
        $foundryModels = @($foundryResp.data)

        Write-Success "Found $($foundryModels.Count) models in Foundry"
        Write-Host ""

        # Cross-reference against our deployment names
        $foundryModelIds = $foundryModels | ForEach-Object { $_.id }
        $foundryTable = $foundryModels | ForEach-Object {
            $mid = $_.id
            $matchedConfig = $modelEntries | Where-Object {
                $_.Id -eq $mid -or $_.DeploymentEnvVar -eq $mid
            } | Select-Object -First 1

            [PSCustomObject]@{
                FoundryId          = $mid
                FoundryObject      = $_.object
                FoundryCreated     = if ($_.created) { [DateTimeOffset]::FromUnixTimeSeconds($_.created).UtcDateTime.ToString('yyyy-MM-dd') } else { '' }
                FoundryDescription = if ($_.description) { $_.description } else { '(none)' }
                MatchesConfig      = if ($matchedConfig) { $matchedConfig.Id } else { '—' }
                ConfigDescription  = if ($matchedConfig) { $matchedConfig.Description } else { '—' }
            }
        }

        # Check for deployment names that don't appear in Foundry
        $foundryDeployments = $modelEntries | Where-Object { $_.Provider -eq 'foundry' }
        foreach ($fd in $foundryDeployments) {
            $foundInFoundry = $foundryModelIds -contains $fd.Id -or
                ($fd.DeploymentEnvVar -and $foundryModelIds -contains $fd.DeploymentEnvVar)
            if (-not $foundInFoundry) {
                Write-Warn "Deployment '$($fd.Id)' (env: $($fd.DeploymentEnvVar)) not found in Foundry model list"
            }
        }

        # Display Foundry models table
        $foundryTable | Format-Table -AutoSize -Property FoundryId, FoundryCreated, MatchesConfig

        # ── Description lookup via Foundry management API ────────────────
        if ($IncludeDescriptions) {
            Write-Host "`n── Foundry model descriptions ──────────────────────────────" -ForegroundColor White

            # Derive the management API base URL from the OpenAI-compatible endpoint.
            # The OpenAI-compatible URL is: https://<resource>.services.ai.azure.com/openai/v1
            # The management API is at:       https://<resource>.services.ai.azure.com/api/projects/<project>/model_registry
            $mgmtBase = $FoundryBaseUrl -replace '/openai/v1$' -replace '/v1$' -replace '/$', ''

            # Try the model_registry endpoint first (Azure AI Foundry SDK).
            # Uses the same api-key header as the OpenAI-compatible endpoint.
            $registryUrls = @(
                "$mgmtBase/api/projects/default/model_registry/models?api-version=2024-02-01",
                "$mgmtBase/api/projects/default/models?api-version=2024-02-01",
                "$mgmtBase/management/models?api-version=2024-02-01"
            )

            $registryModels = $null
            $registryUsed = ''
            foreach ($ru in $registryUrls) {
                try {
                    $regResp = Invoke-RestMethod -Uri $ru -Method Get -Headers $headers -ErrorAction Stop
                    # The response may be { value: [...] } or a flat array
                    if ($regResp.value) { $registryModels = @($regResp.value) }
                    elseif ($regResp -is [array]) { $registryModels = $regResp }
                    else { $registryModels = @($regResp) }
                    if ($registryModels.Count -gt 0) {
                        $registryUsed = $ru
                        Write-Success "Found $($registryModels.Count) models in Foundry model registry"
                        break
                    }
                } catch {
                    continue
                }
            }

            if ($registryModels -and $registryModels.Count -gt 0) {
                Write-Host ""
                Write-Host "  Model descriptions from Foundry (suggested for models.ts):" -ForegroundColor Cyan
                Write-Host ""

                # Build a lookup: Foundry model id → description
                $foundryDescMap = @{}
                foreach ($rm in $registryModels) {
                    $rmId = $rm.id -or $rm.name -or ''
                    $rmDesc = $rm.description -or ''
                    if (-not $rmDesc -and $rm.properties) { $rmDesc = $rm.properties.description -or '' }
                    if ($rmId) { $foundryDescMap[$rmId] = $rmDesc }
                }

                # Cross-reference against our model configs
                $foundryDeployments = $modelEntries | Where-Object { $_.Provider -eq 'foundry' }
                foreach ($fd in $foundryDeployments) {
                    $deployName = $fd.DeploymentEnvVar
                    $foundryId = $null

                    # Try to find the deployment name in Foundry model IDs
                    # The deployment name is the env var value, not the key
                    # We need to match against the actual model IDs from Foundry
                    foreach ($fid in $foundryDescMap.Keys) {
                        if ($fid -eq $fd.Id -or $fid -like "*$($fd.Id)*" -or $fd.Id -like "*$fid*") {
                            $foundryId = $fid
                            break
                        }
                    }

                    $foundryDesc = if ($foundryId) { $foundryDescMap[$foundryId] } else { '' }
                    $codeDesc = $fd.Description

                    if ($foundryDesc) {
                        Write-Host "  $($fd.Id):" -ForegroundColor White
                        Write-Host "    Foundry: $foundryDesc" -ForegroundColor Cyan
                        Write-Host "    Code:    $codeDesc" -ForegroundColor $(if ($codeDesc -ne $foundryDesc) { 'Yellow' } else { 'Green' })
                        if ($codeDesc -ne $foundryDesc) {
                            Write-Host "    → Update models.ts description to: \"$foundryDesc\"" -ForegroundColor Magenta
                        }
                        Write-Host ""
                    } else {
                        Write-Host "  $($fd.Id):" -ForegroundColor White
                        Write-Host "    Code:    $codeDesc" -ForegroundColor Cyan
                        Write-Host "    (no description from Foundry API for this model)" -ForegroundColor Yellow
                        Write-Host ""
                    }
                }

                # Also show any Foundry models not in our config
                $unmatchedFoundryModels = $foundryDescMap.Keys | Where-Object {
                    $matched = $false
                    foreach ($fd in ($modelEntries | Where-Object { $_.Provider -eq 'foundry' })) {
                        if ($_ -eq $fd.Id -or $_ -like "*$($fd.Id)*" -or $fd.Id -like "*$_*") { $matched = $true; break }
                    }
                    -not $matched
                }
                if ($unmatchedFoundryModels.Count -gt 0) {
                    Write-Host "  Additional models in Foundry (not in models.ts):" -ForegroundColor Yellow
                    foreach ($um in $unmatchedFoundryModels) {
                        $desc = $foundryDescMap[$um]
                        if ($desc) { Write-Host "    $um : $desc" -ForegroundColor Cyan }
                        else { Write-Host "    $um" -ForegroundColor Cyan }
                    }
                    Write-Host ""
                }
            } else {
                Write-Warn "Model registry API not available (tried $registryUsed)"
                Write-Host ""
                Write-Host "  The OpenAI-compatible /models endpoint does not return descriptions." -ForegroundColor Yellow
                Write-Host "  To get descriptions, provide a FoundryBaseUrl with management API access." -ForegroundColor Yellow
                Write-Host ""
                Write-Host "  Current descriptions from models.ts (for reference):" -ForegroundColor Cyan
                foreach ($me in $modelEntries) {
                    if ($me.Description) {
                        Write-Host "  $($me.Id): $($me.Description)" -ForegroundColor Cyan
                    }
                }
            }
        }

    } catch {
        Write-Error "Foundry API query failed: $_"
    }
} elseif ($IncludeFoundryModels) {
    Write-Warn "-IncludeFoundryModels requires both -FoundryBaseUrl and -FoundryApiKey"
}

# ── Standalone description listing (no Foundry API needed) ────────────────
if ($IncludeDescriptions -and -not ($IncludeFoundryModels -and $FoundryBaseUrl -and $FoundryApiKey)) {
    Write-Host "`n── Model descriptions from models.ts ──────────────────────────" -ForegroundColor White
    Write-Host ""
    foreach ($me in $modelEntries) {
        $plc = if ($me.PriceLastCheckedUtc) { " (last checked: $($me.PriceLastCheckedUtc))" } else { '' }
        if ($me.Description) {
            Write-Host "  $($me.Id):" -ForegroundColor White
            Write-Host "    description:        $($me.Description)$plc" -ForegroundColor Cyan
        } else {
            Write-Host "  $($me.Id):" -ForegroundColor White
            Write-Host "    (no description)$plc" -ForegroundColor Yellow
        }
        Write-Host ""
    }
    Write-Host "  Tip: Use -IncludeFoundryModels -FoundryBaseUrl <url> -FoundryApiKey <key> to fetch" -ForegroundColor DarkGray
    Write-Host "       descriptions from the Azure AI Foundry management API." -ForegroundColor DarkGray
}

# ═══════════════════════════════════════════════════════════════════════════
# STEP 5 — Report results
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "`n══════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  Results" -ForegroundColor White
Write-Host "══════════════════════════════════════════════════════════════`n" -ForegroundColor White

# Models with matching prices
$matchingModels = @($retailResults | Where-Object {
    $hasInput = $null -ne $_.ApiInput -and [Math]::Abs($_.ApiInput - $_.CodeInput) -le 0.001
    $hasOutput = $null -ne $_.ApiOutput -and [Math]::Abs($_.ApiOutput - $_.CodeOutput) -le 0.001
    $hasCached = $null -ne $_.ApiCached -and [Math]::Abs($_.ApiCached - $_.CodeCached) -le 0.001
    $hasCacheWrite = $null -ne $_.ApiCacheWrite -and $null -ne $_.CodeCacheWrite -and [Math]::Abs($_.ApiCacheWrite - $_.CodeCacheWrite) -le 0.001
    ($hasInput -and $hasOutput) -or ($hasCached -and -not $hasInput -and -not $hasOutput)
})
foreach ($m in $matchingModels) {
    $parts = @()
    if ($null -ne $m.ApiInput) { $parts += "input=$($m.CodeInput)" }
    if ($null -ne $m.ApiOutput) { $parts += "output=$($m.CodeOutput)" }
    if ($null -ne $m.ApiCached -and $null -eq $m.ApiInput) { $parts += "cached=$($m.CodeCached)" }
    $plc = if ($m.PriceLastCheckedUtc) { " [last checked: $($m.PriceLastCheckedUtc)]" } else { '' }
    Write-Success "$($m.ModelId): $($parts -join ' ') — matches Retail API$plc"
}

# Models where cache write matches (shown separately)
$cacheWriteMatches = @($retailResults | Where-Object {
    $null -ne $_.ApiCacheWrite -and $null -ne $_.CodeCacheWrite -and
    [Math]::Abs($_.ApiCacheWrite - $_.CodeCacheWrite) -le 0.001 -and
    $null -ne $_.ApiInput -and $null -ne $_.ApiOutput
})
foreach ($m in $cacheWriteMatches) {
    $plc = if ($m.PriceLastCheckedUtc) { " [last checked: $($m.PriceLastCheckedUtc)]" } else { '' }
    Write-Success "$($m.ModelId): cacheWrite=$($m.CodeCacheWrite) — matches Retail API$plc"
}

# Models with differences
if ($diffResults.Count -gt 0) {
    Write-Host "`n── Price differences found ───────────────────────────────────" -ForegroundColor Yellow
    foreach ($d in $diffResults) {
        Write-Diff "$($d.ModelId) ($($d.Provider)/$($d.Family)):"
        if ($d.DiffInput) {
            Write-Host "         Input:      code=$($d.CodeInput)  api=$($d.ApiInput)  Δ=$($d.DiffInput)" -ForegroundColor Magenta
        }
        if ($d.DiffCached) {
            Write-Host "         Cached:     code=$($d.CodeCached)  api=$($d.ApiCached)  Δ=$($d.DiffCached)" -ForegroundColor Magenta
        }
        if ($d.DiffOutput) {
            Write-Host "         Output:     code=$($d.CodeOutput)  api=$($d.ApiOutput)  Δ=$($d.DiffOutput)" -ForegroundColor Magenta
        }
        if ($d.DiffCacheWrite) {
            Write-Host "         CacheWrite: code=$($d.CodeCacheWrite)  api=$($d.ApiCacheWrite)  Δ=$($d.DiffCacheWrite)" -ForegroundColor Magenta
        }
    }
}

# Models not found in Retail API
$retailModelIds = $retailResults | ForEach-Object { $_.ModelId }
$notFound = @($azureModels | Where-Object { $_.Id -notin $retailModelIds })
if ($notFound.Count -gt 0) {
    Write-Host "`n── Models without Retail API match ───────────────────────────" -ForegroundColor Yellow
    foreach ($m in $notFound) {
        Write-Warn "$($m.Id) ($($m.Provider)) — no matching meter in Retail API for region '$Region'"
    }
}

# ═══════════════════════════════════════════════════════════════════════════
# STEP 6 — Output in requested format
# ═══════════════════════════════════════════════════════════════════════════
if ($OutputFormat -eq 'Json') {
    $output = [PSCustomObject]@{
        GeneratedAt       = (Get-Date).ToUniversalTime().ToString('o')
        Region            = $Region
        DeploymentType    = $DeploymentType
        ModelsChecked     = $modelEntries.Count
        MatchingPrices    = $matchingModels.Count
        PriceDifferences  = $diffResults
        RetailApiResults  = $retailResults
        AllModelConfigs   = $modelEntries
    }
    return $output | ConvertTo-Json -Depth 5
}

if ($OutputFormat -eq 'Csv') {
    if ($diffResults.Count -gt 0) {
        $diffResults | Export-Csv -Path "pricing-diffs-$((Get-Date).ToString('yyyyMMdd-HHmmss')).csv" -NoTypeInformation
        Write-Success "Exported differences to CSV"
    }
    $retailResults | Export-Csv -Path "pricing-all-$((Get-Date).ToString('yyyyMMdd-HHmmss')).csv" -NoTypeInformation
    Write-Success "Exported all retail results to CSV"
}

# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════
Write-Host "`n── Summary ────────────────────────────────────────────────────" -ForegroundColor White
Write-Host "  Models in models.ts:     $($modelEntries.Count)" -ForegroundColor Cyan
Write-Host "  Matched in Retail API:   $($retailResults.Count)" -ForegroundColor Cyan
Write-Host "  Prices matching:         $($matchingModels.Count)" -ForegroundColor Green
Write-Host "  Prices differing:        $($diffResults.Count)" -ForegroundColor $(if ($diffResults.Count -gt 0) { 'Yellow' } else { 'Green' })
Write-Host "  Not found in API:        $($notFound.Count)" -ForegroundColor $(if ($notFound.Count -gt 0) { 'Yellow' } else { 'Green' })
Write-Host "`nDone." -ForegroundColor White
