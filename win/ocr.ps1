# ocr.ps1 — the OCR engine that ships in Windows (Windows.Media.Ocr), as a line protocol.
#
# A line in, a line out, like helper.cs, but in a process of its own and in Windows PowerShell 5.1,
# because that is what can load WinRT types with nothing installed (PowerShell 7 cannot).
# Started once by win/ocr.ts and kept: loading the types and the engine costs about a second,
# a recognition after that a few hundred milliseconds.
#
#   png <scale> <base64>      recognise a PNG; scale 1..4 enlarges it first (small UI text reads far better at 2)
#   file <scale> <path>       the same, from a Windows path
#   langs                     the recognizer languages installed
#
# Reply: one line of JSON. {"ms":..,"lang":"en-US","lines":[{"text":"..","words":[{"t":"..","x":..,"y":..,"w":..,"h":..}]}]}
# with every rectangle in the pixels of the image as it was sent (the scale is divided out), or {"error":".."}.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

# WinRT hands back IAsyncOperation<T>; PowerShell has no await, so go through AsTask<T>().Wait().
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($operation, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $null = $task.Wait(20000)
  $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine -or $engine.RecognizerLanguage.LanguageTag -notlike "en*") {
  # UI text is mostly Latin; an English recognizer reads it better than, say, a Chinese one reads English.
  $english = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object { $_.LanguageTag -like "en*" } | Select-Object -First 1
  if ($english) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($english) }
}

function Recognize([byte[]]$bytes, [int]$scale) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $memory = New-Object System.IO.MemoryStream(, $bytes)
  $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  while ($scale -gt 1 -and ($decoder.PixelWidth * $scale -gt $max -or $decoder.PixelHeight * $scale -gt $max)) { $scale-- }
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  $transform.ScaledWidth = $decoder.PixelWidth * $scale
  $transform.ScaledHeight = $decoder.PixelHeight * $scale
  $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Cubic
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
    $transform, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @(foreach ($line in $result.Lines) {
    @{ text = $line.Text; words = @(foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      @{ t = $word.Text; x = [math]::Round($r.X / $scale, 1); y = [math]::Round($r.Y / $scale, 1); w = [math]::Round($r.Width / $scale, 1); h = [math]::Round($r.Height / $scale, 1) }
    }) }
  })
  $bitmap.Dispose(); $stream.Dispose(); $memory.Dispose()
  @{ ms = [int]$watch.ElapsedMilliseconds; lang = $engine.RecognizerLanguage.LanguageTag; scale = $scale; width = [int]$decoder.PixelWidth; height = [int]$decoder.PixelHeight; lines = $lines }
}

[Console]::Out.WriteLine((@{ ready = ($null -ne $engine); lang = $(if ($engine) { $engine.RecognizerLanguage.LanguageTag } else { $null }) } | ConvertTo-Json -Compress))
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $reply = $null
  try {
    $verb, $scale, $rest = $line.Trim() -split " ", 3
    if ($verb -eq "langs") { $reply = @{ langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) } }
    elseif ($null -eq $engine) { $reply = @{ error = "no OCR language is installed (Settings > Time & language > Language > add English, with its optional OCR feature)" } }
    elseif ($verb -eq "png") { $reply = Recognize ([Convert]::FromBase64String($rest)) ([int]$scale) }
    elseif ($verb -eq "file") { $reply = Recognize ([System.IO.File]::ReadAllBytes($rest)) ([int]$scale) }
    else { $reply = @{ error = "unknown request" } }
  } catch { $reply = @{ error = $_.Exception.Message } }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
}
