$body = @{
  license_key = "8f338fea-d5c3-4658-a484-3f86d77ec9ba"
  email = "pilsnereditor@gmail.com"
  password = "_KpbVWKvFRCQ"
  remember = $true
} | ConvertTo-Json

$loginResp = Invoke-WebRequest -Uri "http://178.238.224.17:5000/api/client/login" -Method POST -ContentType "application/json" -Body $body -SessionVariable sess -UseBasicParsing
Write-Host "Login response: $($loginResp.Content)"

$dashboard = Invoke-WebRequest -Uri "http://178.238.224.17:5000/" -WebSession $sess -UseBasicParsing
$dashboard.Content | Out-File -FilePath "scratch\ref_dashboard.html" -Encoding UTF8
Write-Host "Dashboard saved. Length: $($dashboard.Content.Length)"
