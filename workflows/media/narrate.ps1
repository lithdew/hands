param([Parameter(Mandatory=$true)][string]$InputJson, [Parameter(Mandatory=$true)][string]$OutputWav)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$request = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8 | ConvertFrom-Json
if ($request.text.Length -gt 800) { throw 'Narration text is too long' }
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice.Rate = 0
  $voice.SetOutputToWaveFile($OutputWav)
  $voice.Speak([string]$request.text)
} finally {
  $voice.Dispose()
}
