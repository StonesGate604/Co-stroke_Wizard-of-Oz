param(
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$FrontendOrigin,
    [string]$Region = 'us-central1',
    [switch]$Update
)
$ErrorActionPreference = 'Stop'
if ($ProjectId -notmatch '^[a-z][a-z0-9-]{4,61}[a-z0-9]$') { throw 'Invalid project ID.' }
$origin = [uri]$FrontendOrigin
if ($origin.Scheme -ne 'https' -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment) { throw 'FrontendOrigin must be an HTTPS origin, without a repository path.' }
$FrontendOrigin = $origin.GetLeftPart([System.UriPartial]::Authority)
$repoRoot = Split-Path -Parent $PSScriptRoot
$service = 'co-stroke-woz'
$database = 'co-stroke-woz'
$accountId = 'co-stroke-woz-runtime'
$account = "$accountId@$ProjectId.iam.gserviceaccount.com"
function Invoke-Gcloud {
    & gcloud @args
    if ($LASTEXITCODE -ne 0) { throw "Google Cloud command failed: $($args[0..1] -join ' ')" }
}
$existing = & gcloud run services list --project=$ProjectId --region=$Region --filter="metadata.name=$service" --format='value(metadata.name)'
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing services.' }
if ($existing -and !$Update) { throw 'co-stroke-woz already exists. Inspect it first, then explicitly pass -Update.' }
Invoke-Gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com --project=$ProjectId --quiet
$databases = $null
for ($attempt = 0; $attempt -lt 6; $attempt++) {
    $databases = & gcloud firestore databases list --project=$ProjectId --format='value(name)' --quiet
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 5) { throw 'Cannot inspect Firestore databases after waiting for API activation.' }
    Write-Output 'Waiting for Firestore API activation...'
    Start-Sleep -Seconds 10
}
if ($databases -notcontains "projects/$ProjectId/databases/$database") {
    Invoke-Gcloud firestore databases create --project=$ProjectId --database=$database --location=$Region --type=firestore-native --delete-protection --quiet
}
$accounts = & gcloud iam service-accounts list --project=$ProjectId --filter="email=$account" --format='value(email)'
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect runtime accounts.' }
if (!$accounts) { Invoke-Gcloud iam service-accounts create $accountId --project=$ProjectId --display-name='Independent co-Stroke WoZ runtime' --quiet }
$condition = 'expression=resource.name=="projects/' + $ProjectId + '/databases/' + $database + '",title=woz-database-only'
for ($attempt = 0; $attempt -lt 4; $attempt++) {
    & gcloud projects add-iam-policy-binding $ProjectId --member="serviceAccount:$account" --role=roles/datastore.user --condition=$condition --quiet --format='none'
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 3) { throw 'Cannot grant the runtime account access to the dedicated database.' }
    Start-Sleep -Seconds ([int][Math]::Pow(2,$attempt + 1))
}
$secretFile = Join-Path $repoRoot '.woz-admin.secret'
if (!(Test-Path -LiteralPath $secretFile)) {
    $secret = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    [System.IO.File]::WriteAllText($secretFile,$secret)
}
$configFile = Join-Path $repoRoot '.woz-env.secret'
try {
    @{ STORE='firestore'; FIRESTORE_DATABASE=$database; ALLOWED_ORIGINS=$FrontendOrigin; ADMIN_TOKEN=[System.IO.File]::ReadAllText($secretFile).Trim() } | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding utf8
    Push-Location $repoRoot
    try {
        Invoke-Gcloud run deploy $service --project=$ProjectId --region=$Region --source=. --service-account=$account --allow-unauthenticated --no-use-http2 --timeout=3600 --concurrency=20 --max-instances=1 --min-instances=0 --cpu=1 --memory=512Mi --env-vars-file=$configFile --labels=application=co-stroke-woz --quiet
    } finally { Pop-Location }
} finally { if (Test-Path -LiteralPath $configFile) { Remove-Item -LiteralPath $configFile -Force } }
$url = & gcloud run services describe $service --project=$ProjectId --region=$Region --format='value(status.url)'
if ($LASTEXITCODE -ne 0) { throw 'Cannot read deployed service URL.' }
Write-Output "Independent backend: $url"
Write-Output 'Check /health, then set public/config.js syncServerUrl to this URL and publish the frontend.'
Write-Output 'Admin key saved in ignored .woz-admin.secret. Do not publish it or add it to public/config.js.'
