[CmdletBinding()]
param(
    [string]$IndexPath,
    [string]$DecisionsPath,
    [string]$JsonOutputPath,
    [string]$CsvOutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($IndexPath)) {
    $IndexPath = Join-Path $repositoryRoot 'data\yandex-disk-index.json'
}
if ([string]::IsNullOrWhiteSpace($DecisionsPath)) {
    $DecisionsPath = Join-Path $repositoryRoot 'data\review-decisions.json'
}
if ([string]::IsNullOrWhiteSpace($JsonOutputPath)) {
    $JsonOutputPath = Join-Path $repositoryRoot 'reports\delete-plan.json'
}
if ([string]::IsNullOrWhiteSpace($CsvOutputPath)) {
    $CsvOutputPath = Join-Path $repositoryRoot 'reports\delete-plan.csv'
}

$index = Get-Content -Raw -LiteralPath $IndexPath -Encoding utf8 | ConvertFrom-Json -Depth 20
$decisionsDocument = Get-Content -Raw -LiteralPath $DecisionsPath -Encoding utf8 | ConvertFrom-Json -Depth 20
$decisionFiles = $decisionsDocument.files
if ($null -eq $decisionFiles) {
    throw 'В review-decisions.json отсутствует объект files.'
}

$indexByPath = @{}
foreach ($file in ($index | Where-Object type -eq 'file')) {
    $indexByPath[[string]$file.path] = $file
}

$plan = [System.Collections.Generic.List[object]]::new()
foreach ($property in $decisionFiles.PSObject.Properties) {
    $path = [string]$property.Name
    $decision = $property.Value
    if ([string]$decision.status -ne 'DELETE') {
        continue
    }
    if (-not $indexByPath.ContainsKey($path)) {
        throw "DELETE-решение ссылается на отсутствующий в индексе путь: $path"
    }
    $file = $indexByPath[$path]
    $plan.Add([pscustomobject][ordered]@{
        path = $path
        name = [string]$file.name
        viewer_url = [string]$file.viewer_url
        reviewer = [string]$decision.reviewer
        reviewed_at = $decision.reviewed_at
    })
}

$orderedPlan = @($plan | Sort-Object path)
$jsonDirectory = Split-Path -Parent $JsonOutputPath
$csvDirectory = Split-Path -Parent $CsvOutputPath
New-Item -ItemType Directory -Force -Path $jsonDirectory, $csvDirectory | Out-Null

if ($orderedPlan.Count -eq 0) {
    [IO.File]::WriteAllText($JsonOutputPath, "[]`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText(
        $CsvOutputPath,
        '"path","name","viewer_url","reviewer","reviewed_at"' + "`n",
        [Text.UTF8Encoding]::new($false)
    )
}
else {
    $orderedPlan | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $JsonOutputPath -Encoding utf8
    $orderedPlan | Export-Csv -LiteralPath $CsvOutputPath -NoTypeInformation -Encoding utf8
}

Write-Output "DELETE_MARKED: $($orderedPlan.Count)"
Write-Output 'DELETE_PLAN_CREATED: YES'
