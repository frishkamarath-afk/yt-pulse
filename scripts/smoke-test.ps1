param(
  [string]$Url = "http://localhost:4173/",
  [int]$DebugPort = 9223
)

$edgePaths = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
  throw "Microsoft Edge не найден."
}

function Invoke-Cdp {
  param(
    [System.Net.WebSockets.ClientWebSocket]$Socket,
    [int]$Id,
    [string]$Method,
    [hashtable]$Params = @{}
  )

  $payload = @{
    id = $Id
    method = $Method
    params = $Params
  } | ConvertTo-Json -Depth 12 -Compress

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $segment = [System.ArraySegment[byte]]::new($bytes)
  $null = $Socket.SendAsync(
    $segment,
    [System.Net.WebSockets.WebSocketMessageType]::Text,
    $true,
    [System.Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()

  while ($true) {
    $stream = [System.IO.MemoryStream]::new()
    do {
      $buffer = New-Object byte[] 65536
      $result = $Socket.ReceiveAsync(
        [System.ArraySegment[byte]]::new($buffer),
        [System.Threading.CancellationToken]::None
      ).GetAwaiter().GetResult()
      $stream.Write($buffer, 0, $result.Count)
    } while (-not $result.EndOfMessage)

    $message = [System.Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
    if ($message.id -eq $Id) {
      return $message
    }
  }
}

$profile = Join-Path $env:TEMP "yt-pulse-edge-profile"
$arguments = @(
  "--headless",
  "--disable-gpu",
  "--remote-allow-origins=*",
  "--remote-debugging-port=$DebugPort",
  "--user-data-dir=`"$profile`"",
  "about:blank"
) -join " "

$process = Start-Process -FilePath $edge -ArgumentList $arguments -WindowStyle Hidden -PassThru
$socket = $null

try {
  $target = $null
  for ($attempt = 0; $attempt -lt 30 -and -not $target; $attempt++) {
    Start-Sleep -Milliseconds 200
    try {
      $response = Invoke-RestMethod "http://localhost:$DebugPort/json/list"
      $targets = @($response)
      $target = $targets |
        Where-Object { $_.type -eq "page" } |
        Select-Object -First 1
    }
    catch {
      $target = $null
    }
  }

  if (-not $target) {
    throw "Не удалось подключиться к тестовому браузеру."
  }

  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $null = $socket.ConnectAsync(
    [Uri][string]$target.webSocketDebuggerUrl,
    [System.Threading.CancellationToken]::None
  ).GetAwaiter().GetResult()

  Invoke-Cdp -Socket $socket -Id 1 -Method "Page.enable" | Out-Null
  Invoke-Cdp -Socket $socket -Id 2 -Method "Runtime.enable" | Out-Null
  Invoke-Cdp -Socket $socket -Id 3 -Method "Page.navigate" -Params @{ url = $Url } | Out-Null
  Start-Sleep -Milliseconds 1800

  $initial = Invoke-Cdp -Socket $socket -Id 4 -Method "Runtime.evaluate" -Params @{
    expression = @"
(() => ({
  ready: document.readyState,
  rows: document.querySelectorAll('#channels-body tr').length,
  heading: document.querySelector('h1')?.textContent?.trim(),
  demoVisible: document.querySelector('#demo-banner')?.hidden === false,
  loadError: document.querySelector('#last-updated')?.textContent?.includes('Ошибка') === true
}))()
"@
    returnByValue = $true
  }

  $popover = Invoke-Cdp -Socket $socket -Id 5 -Method "Runtime.evaluate" -Params @{
    expression = @"
(() => {
  document.querySelector('[data-details]')?.click();
  return {
    popovers: document.querySelectorAll('.video-popover').length,
    expanded: document.querySelector('[data-details]')?.getAttribute('aria-expanded')
  };
})()
"@
    returnByValue = $true
  }

  $search = Invoke-Cdp -Socket $socket -Id 6 -Method "Runtime.evaluate" -Params @{
    expression = @"
(() => {
  const input = document.querySelector('#channel-search');
  input.value = 'meta';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return {
    rows: document.querySelectorAll('#channels-body tr').length,
    firstTitle: document.querySelector('.channel-copy strong')?.textContent?.trim()
  };
})()
"@
    returnByValue = $true
  }

  [PSCustomObject]@{
    Initial = $initial.result.result.value | ConvertTo-Json -Compress
    Popover = $popover.result.result.value | ConvertTo-Json -Compress
    Search = $search.result.result.value | ConvertTo-Json -Compress
  } | Format-List
}
finally {
  if ($socket) {
    $socket.Dispose()
  }
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}
