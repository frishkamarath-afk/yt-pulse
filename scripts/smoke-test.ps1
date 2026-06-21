param(
  [string]$Url = "http://localhost:4173/",
  [int]$DebugPort = 9223,
  [ValidateSet("dashboard", "admin")]
  [string]$Page = "dashboard"
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

  if ($Page -eq "admin") {
    $initial = Invoke-Cdp -Socket $socket -Id 4 -Method "Runtime.evaluate" -Params @{
      expression = @"
(() => ({
  ready: document.readyState,
  heading: document.querySelector('h1')?.textContent?.trim(),
  authVisible: document.querySelector('#auth-card')?.hidden === false,
  editorHidden: document.querySelector('#editor-card')?.hidden === true,
  tokenType: document.querySelector('#github-token')?.type,
  scriptLoaded: typeof connect === 'function'
}))()
"@
      returnByValue = $true
    }

    $editor = Invoke-Cdp -Socket $socket -Id 5 -Method "Runtime.evaluate" -Params @{
      expression = @"
(async () => {
  const requests = [];
  const config = {
    keywords: ['alpha', 'beta'],
    excludeShorts: true,
    maxChannels: 30
  };
  window.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });
    if (url.endsWith('/user')) return json({ login: 'test-admin' });
    if (url.includes('/contents/config/keywords.json') && (options.method || 'GET') === 'GET') {
      const bytes = new TextEncoder().encode(JSON.stringify(config));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return json({ sha: 'old-sha', content: btoa(binary) });
    }
    if (url.includes('/contents/config/keywords.json') && options.method === 'PUT') {
      return json({ content: { sha: 'new-sha' } });
    }
    if (url.includes('/dispatches') && options.method === 'POST') {
      return new Response(null, { status: 204 });
    }
    return json({ message: 'Unexpected request' }, 404);
  };
  await connect('fake-token', false);
  document.querySelector('#keyword-input').value = 'gamma, delta';
  document.querySelector('#add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await saveChanges();
  return {
    items: document.querySelectorAll('.keyword-item').length,
    total: document.querySelector('#keyword-total')?.textContent?.trim(),
    keywords: [...state.keywords],
    successVisible: document.querySelector('#success-card')?.hidden === false,
    putRequests: requests.filter((request) => request.method === 'PUT').length,
    dispatchRequests: requests.filter((request) => request.url.includes('/dispatches')).length
  };
})()
"@
      returnByValue = $true
      awaitPromise = $true
    }

    [PSCustomObject]@{
      Initial = $initial.result.result.value | ConvertTo-Json -Compress
      Editor = $editor.result.result.value | ConvertTo-Json -Compress
    } | Format-List
  }
  else {
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
}
finally {
  if ($socket) {
    $socket.Dispose()
  }
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}
