[CmdletBinding()]
param(
    [string]$IndexPath,
    [string]$OutputPath,
    [int]$ExpectedFiles = 657
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($IndexPath)) {
    $IndexPath = Join-Path $repositoryRoot 'data\yandex-disk-index.json'
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repositoryRoot 'index.html'
}

$index = Get-Content -Raw -LiteralPath $IndexPath -Encoding utf8 | ConvertFrom-Json -Depth 20
$folders = @($index | Where-Object type -eq 'dir')
$files = @($index | Where-Object type -eq 'file')
if ($files.Count -ne $ExpectedFiles) {
    throw "Ожидалось $ExpectedFiles файлов, найдено $($files.Count)."
}
if ($files | Where-Object { [string]::IsNullOrWhiteSpace([string]$_.viewer_url) }) {
    throw 'В индексе есть файлы без viewer_url.'
}

$nodeMap = @{}
foreach ($entry in $index) {
    $nodeMap[[string]$entry.path] = [pscustomobject]@{
        resource = $entry
        children = [System.Collections.Generic.List[object]]::new()
    }
}

foreach ($entry in ($index | Where-Object path -ne '/')) {
    $parentPath = [string]$entry.parent_path
    if (-not $nodeMap.ContainsKey($parentPath)) {
        throw "Не найден родитель '$parentPath' для '$($entry.path)'."
    }
    $nodeMap[$parentPath].children.Add($nodeMap[[string]$entry.path])
}
if (-not $nodeMap.ContainsKey('/')) {
    throw 'В индексе отсутствует корневая папка.'
}

function Encode-Html {
    param([string]$Value)
    return [System.Net.WebUtility]::HtmlEncode($Value)
}

function Add-CatalogNode {
    param(
        [object]$Node,
        [int]$Indent,
        [Text.StringBuilder]$Builder
    )

    $entry = $Node.resource
    $padding = '    ' * $Indent
    $name = Encode-Html ([string]$entry.name)
    $path = Encode-Html ([string]$entry.path)

    if ($entry.type -eq 'file') {
        $viewerUrl = [string]$entry.viewer_url
        $href = Encode-Html $viewerUrl
        $extension = Encode-Html ([string]$entry.extension)
        $modified = Encode-Html ([string]$entry.modified)
        [void]$Builder.AppendLine("$padding<li class=`"file-row`" data-path=`"$path`" data-name=`"$name`" data-extension=`"$extension`" data-modified=`"$modified`">")
        [void]$Builder.AppendLine("$padding    <a class=`"file-name`" href=`"$href`" target=`"_blank`" rel=`"noopener noreferrer`">$name</a>")
        [void]$Builder.AppendLine("$padding    <span class=`"file-meta`">$extension · $modified</span>")
        [void]$Builder.AppendLine("$padding    <a class=`"open-link`" href=`"$href`" target=`"_blank`" rel=`"noopener noreferrer`">Открыть</a>")
        [void]$Builder.AppendLine("$padding    <button type=`"button`" data-status=`"KEEP`">Оставить</button>")
        [void]$Builder.AppendLine("$padding    <button type=`"button`" data-status=`"ARCHIVE`">Архив</button>")
        [void]$Builder.AppendLine("$padding    <button type=`"button`" data-status=`"UPDATE`">Обновить</button>")
        [void]$Builder.AppendLine("$padding    <button type=`"button`" data-status=`"DUPLICATE`">Дубликат</button>")
        [void]$Builder.AppendLine("$padding    <button type=`"button`" data-status=`"DELETE`">Удалить</button>")
        [void]$Builder.AppendLine("$padding    <button type=`"button`" data-status=`"UNSURE`">Не уверен</button>")
        [void]$Builder.AppendLine("$padding</li>")
        return
    }

    $depth = [int]$entry.depth
    [void]$Builder.AppendLine("$padding<li class=`"folder`" data-depth=`"$depth`">")
    [void]$Builder.AppendLine("$padding    <div class=`"folder-line`"><button type=`"button`" class=`"folder-toggle`" aria-expanded=`"true`">−</button><span>$name</span></div>")
    [void]$Builder.AppendLine("$padding    <ul>")
    foreach ($child in $Node.children) {
        Add-CatalogNode -Node $child -Indent ($Indent + 2) -Builder $Builder
    }
    [void]$Builder.AppendLine("$padding    </ul>")
    [void]$Builder.AppendLine("$padding</li>")
}

$html = [Text.StringBuilder]::new(4194304)
[void]$html.AppendLine('<!doctype html>')
[void]$html.AppendLine('<html lang="ru">')
[void]$html.AppendLine('<head>')
[void]$html.AppendLine('    <meta charset="utf-8">')
[void]$html.AppendLine('    <meta name="viewport" content="width=device-width, initial-scale=1">')
[void]$html.AppendLine('    <title>Ревизия — Домиан Франчайзинг</title>')
[void]$html.AppendLine('    <link rel="stylesheet" href="styles.css">')
[void]$html.AppendLine('</head>')
[void]$html.AppendLine('<body>')
[void]$html.AppendLine('    <main>')
[void]$html.AppendLine('        <header class="toolbar">')
[void]$html.AppendLine('            <h1>Ревизия файлов — Домиан Франчайзинг</h1>')
[void]$html.AppendLine('            <div class="summary">')
[void]$html.AppendLine("                <span>Всего: <strong id=`"count-total`">$($files.Count)</strong></span>")
[void]$html.AppendLine('                <span>Проверено: <strong id="count-reviewed">0</strong></span>')
[void]$html.AppendLine("                <span>Не проверено: <strong id=`"count-unreviewed`">$($files.Count)</strong></span>")
[void]$html.AppendLine('                <span>Оставить: <strong id="count-KEEP">0</strong></span>')
[void]$html.AppendLine('                <span>Архив: <strong id="count-ARCHIVE">0</strong></span>')
[void]$html.AppendLine('                <span>Обновить: <strong id="count-UPDATE">0</strong></span>')
[void]$html.AppendLine('                <span>Дубликат: <strong id="count-DUPLICATE">0</strong></span>')
[void]$html.AppendLine('                <span>Удалить: <strong id="count-DELETE">0</strong></span>')
[void]$html.AppendLine('                <span>Не уверен: <strong id="count-UNSURE">0</strong></span>')
[void]$html.AppendLine('                <strong id="progress">0 / 657 — 0,0%</strong>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('            <div class="filters" aria-label="Фильтры">')
[void]$html.AppendLine('                <button type="button" data-filter="ALL" class="active-filter">Все</button>')
[void]$html.AppendLine('                <button type="button" data-filter="UNREVIEWED">Только непроверенные</button>')
[void]$html.AppendLine('                <button type="button" data-filter="KEEP">Оставить</button>')
[void]$html.AppendLine('                <button type="button" data-filter="ARCHIVE">Архив</button>')
[void]$html.AppendLine('                <button type="button" data-filter="UPDATE">Обновить</button>')
[void]$html.AppendLine('                <button type="button" data-filter="DUPLICATE">Дубликат</button>')
[void]$html.AppendLine('                <button type="button" data-filter="DELETE">Удалить</button>')
[void]$html.AppendLine('                <button type="button" data-filter="UNSURE">Не уверен</button>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('            <div class="actions">')
[void]$html.AppendLine('                <button id="expand-all" type="button">Развернуть всё</button>')
[void]$html.AppendLine('                <button id="collapse-all" type="button">Свернуть всё</button>')
[void]$html.AppendLine('                <button id="export-results" type="button">Экспорт JSON</button>')
[void]$html.AppendLine('                <label>Импорт JSON <input id="import-results" type="file" accept="application/json,.json"></label>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('            <div class="settings">')
[void]$html.AppendLine('                <label>Проверяющий <input id="reviewer" type="text" autocomplete="name"></label>')
[void]$html.AppendLine('                <label>GitHub token <input id="github-token" type="password" autocomplete="off" spellcheck="false"></label>')
[void]$html.AppendLine('                <button id="clear-token" type="button">Очистить token</button>')
[void]$html.AppendLine('                <button id="save-now" type="button">Сохранить сейчас</button>')
[void]$html.AppendLine('                <span id="sync-state" class="sync-state" data-state="dirty">Загрузка…</span>')
[void]$html.AppendLine('                <span id="last-sync">Последняя синхронизация: ещё не выполнялась</span>')
[void]$html.AppendLine('                <span id="message" role="status"></span>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('        </header>')
[void]$html.AppendLine('        <ul id="catalog" class="tree">')
Add-CatalogNode -Node $nodeMap['/'] -Indent 3 -Builder $html
[void]$html.AppendLine('        </ul>')
[void]$html.AppendLine('    </main>')
[void]$html.AppendLine('    <script src="review.js" defer></script>')
[void]$html.AppendLine('</body>')
[void]$html.AppendLine('</html>')

[IO.File]::WriteAllText($OutputPath, $html.ToString(), [Text.UTF8Encoding]::new($false))

$rendered = Get-Content -Raw -LiteralPath $OutputPath -Encoding utf8
$rows = [regex]::Matches($rendered, '<li class="file-row"').Count
$statusButtons = [regex]::Matches($rendered, 'data-status="(?:KEEP|ARCHIVE|UPDATE|DUPLICATE|DELETE|UNSURE)"').Count
if ($rows -ne $files.Count -or $statusButtons -ne ($files.Count * 6)) {
    throw "Проверка HTML не пройдена: rows=$rows, status_buttons=$statusButtons."
}

Write-Output "FILES: $($files.Count)"
Write-Output "ROWS_WITH_CONTROLS: $rows"
