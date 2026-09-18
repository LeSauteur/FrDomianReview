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
        [void]$Builder.AppendLine("$padding    <div class=`"file-heading`">")
        [void]$Builder.AppendLine("$padding        <a class=`"file-name`" href=`"$href`" target=`"_blank`" rel=`"noopener noreferrer`">$name</a>")
        [void]$Builder.AppendLine("$padding        <span class=`"file-meta`">$extension · $modified</span>")
        [void]$Builder.AppendLine("$padding    </div>")
        [void]$Builder.AppendLine("$padding    <div class=`"file-actions`">")
        [void]$Builder.AppendLine("$padding        <a class=`"open-link`" href=`"$href`" target=`"_blank`" rel=`"noopener noreferrer`">Открыть</a>")
        [void]$Builder.AppendLine("$padding        <button type=`"button`" data-status=`"KEEP`">Оставить</button>")
        [void]$Builder.AppendLine("$padding        <button type=`"button`" data-status=`"ARCHIVE`">Архив</button>")
        [void]$Builder.AppendLine("$padding        <button type=`"button`" data-status=`"UPDATE`">Обновить</button>")
        [void]$Builder.AppendLine("$padding        <button type=`"button`" data-status=`"DUPLICATE`">Дубликат</button>")
        [void]$Builder.AppendLine("$padding        <button type=`"button`" data-status=`"DELETE`" title=`"Пометить для удаления после ревизии`">Удалить</button>")
        [void]$Builder.AppendLine("$padding        <button type=`"button`" data-status=`"UNSURE`">Не уверен</button>")
        [void]$Builder.AppendLine("$padding    </div>")
        [void]$Builder.AppendLine("$padding    <div class=`"comments-area`"></div>")
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
[void]$html.AppendLine('            <div class="toolbar-top">')
[void]$html.AppendLine('                <div><h1>Ревизия файлов</h1><p class="toolbar-subtitle">Домиан Франчайзинг</p></div>')
[void]$html.AppendLine('                <div class="sync-summary">')
[void]$html.AppendLine('                    <span id="sync-state" class="sync-state" data-state="dirty">Загрузка…</span>')
[void]$html.AppendLine('                    <span id="last-sync">Последняя синхронизация: ещё не выполнялась</span>')
[void]$html.AppendLine('                    <button id="save-now" type="button">Сохранить сейчас</button>')
[void]$html.AppendLine('                </div>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('            <div class="summary">')
[void]$html.AppendLine("                <span class=`"metric`">Всего <strong id=`"count-total`">$($files.Count)</strong></span>")
[void]$html.AppendLine('                <span class="metric">Проверено <strong id="count-reviewed">0</strong></span>')
[void]$html.AppendLine("                <span class=`"metric`">Осталось <strong id=`"count-unreviewed`">$($files.Count)</strong></span>")
[void]$html.AppendLine('                <strong class="metric metric-progress" id="progress">0 / 657 — 0,0%</strong>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('            <div class="status-chips">')
[void]$html.AppendLine('                <span class="status-chip" data-status="KEEP">Оставить <strong id="count-KEEP">0</strong></span>')
[void]$html.AppendLine('                <span class="status-chip" data-status="ARCHIVE">Архив <strong id="count-ARCHIVE">0</strong></span>')
[void]$html.AppendLine('                <span class="status-chip" data-status="UPDATE">Обновить <strong id="count-UPDATE">0</strong></span>')
[void]$html.AppendLine('                <span class="status-chip" data-status="DUPLICATE">Дубликат <strong id="count-DUPLICATE">0</strong></span>')
[void]$html.AppendLine('                <span class="status-chip" data-status="DELETE">Удалить <strong id="count-DELETE">0</strong></span>')
[void]$html.AppendLine('                <span class="status-chip" data-status="UNSURE">Не уверен <strong id="count-UNSURE">0</strong></span>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('            <div class="filter-tools">')
[void]$html.AppendLine('                <label class="search-label">Поиск <input id="file-search" type="search" placeholder="Поиск по файлам…" autocomplete="off"></label>')
[void]$html.AppendLine('            <div class="filters" aria-label="Фильтры">')
[void]$html.AppendLine('                <button type="button" data-filter="ALL" class="active-filter">Все</button>')
[void]$html.AppendLine('                <button type="button" data-filter="UNREVIEWED">Только непроверенные</button>')
[void]$html.AppendLine('                <button type="button" data-filter="KEEP">Оставить</button>')
[void]$html.AppendLine('                <button type="button" data-filter="ARCHIVE">Архив</button>')
[void]$html.AppendLine('                <button type="button" data-filter="UPDATE">Обновить</button>')
[void]$html.AppendLine('                <button type="button" data-filter="DUPLICATE">Дубликат</button>')
[void]$html.AppendLine('                <button type="button" data-filter="DELETE">Удалить</button>')
[void]$html.AppendLine('                <button type="button" data-filter="UNSURE">Не уверен</button>')
[void]$html.AppendLine('                <button type="button" data-filter="COMMENTS">Есть комментарии</button>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('            </div>')
[void]$html.AppendLine('            <div class="actions">')
[void]$html.AppendLine('                <button id="expand-all" type="button">Развернуть всё</button>')
[void]$html.AppendLine('                <button id="collapse-all" type="button">Свернуть всё</button>')
[void]$html.AppendLine('                <span class="action-divider"></span>')
[void]$html.AppendLine('                <button id="export-results" type="button">Экспорт JSON</button>')
[void]$html.AppendLine('                <label>Импорт JSON <input id="import-results" type="file" accept="application/json,.json"></label>')
[void]$html.AppendLine('                <label class="reviewer-label">Проверяющий <select id="reviewer">')
[void]$html.AppendLine('                    <option value="">Выберите сотрудника</option>')
[void]$html.AppendLine('                    <option value="Егупов Алексей">Егупов Алексей</option>')
[void]$html.AppendLine('                    <option value="Андрейченко Валерий">Андрейченко Валерий</option>')
[void]$html.AppendLine('                    <option value="Марина Олеговна">Марина Олеговна</option>')
[void]$html.AppendLine('                </select></label>')
[void]$html.AppendLine('                <details class="token-settings"><summary>GitHub token</summary>')
[void]$html.AppendLine('                    <div class="token-fields"><input id="github-token" type="password" autocomplete="off" spellcheck="false" aria-label="GitHub token"><button id="clear-token" type="button">Очистить token</button></div>')
[void]$html.AppendLine('                </details>')
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
$rowMatches = [regex]::Matches($rendered, '(?s)<li class="file-row"[^>]*>.*?</li>')
$rows = $rowMatches.Count
$rowsWithControls = 0
foreach ($row in $rowMatches) {
    $statusButtons = [regex]::Matches($row.Value, '<button type="button" data-status="(?:KEEP|ARCHIVE|UPDATE|DUPLICATE|DELETE|UNSURE)"').Count
    if ($statusButtons -eq 6) {
        $rowsWithControls++
    }
}
if ($rows -ne $files.Count -or $rowsWithControls -ne $files.Count) {
    throw "Проверка HTML не пройдена: rows=$rows, rows_with_controls=$rowsWithControls."
}

Write-Output "FILES: $($files.Count)"
Write-Output "ROWS_WITH_CONTROLS: $rowsWithControls"
