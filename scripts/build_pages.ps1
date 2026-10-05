$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$buildDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectRoot ".pages-build"))
if ((Split-Path -Parent $buildDirectory) -ne $projectRoot -or
    (Split-Path -Leaf $buildDirectory) -ne ".pages-build") {
    throw "The Pages build must stay in the project's .pages-build directory."
}
if (Test-Path -LiteralPath $buildDirectory) {
    $existing = Get-Item -Force -LiteralPath $buildDirectory
    if ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to replace a linked Pages build directory."
    }
    Remove-Item -LiteralPath $buildDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $buildDirectory | Out-Null

# Only public application assets belong in the deployed website.
foreach ($directory in @("public", "src", "schemas")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $buildDirectory -Recurse
}
$dataDirectory = Join-Path $buildDirectory "data"
New-Item -ItemType Directory -Path $dataDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "data/examples") -Destination $dataDirectory -Recurse

$entryPage = @'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>co-Stroke</title>
  <meta http-equiv="refresh" content="0; url=./public/">
</head>
<body>
  <a href="./public/">Open co-Stroke</a>
  <script>location.replace("./public/" + location.search + location.hash);</script>
</body>
</html>
'@
[System.IO.File]::WriteAllText((Join-Path $buildDirectory "index.html"), $entryPage)
[System.IO.File]::WriteAllText((Join-Path $buildDirectory ".nojekyll"), "")
Write-Output "Pages assets prepared in $buildDirectory"
