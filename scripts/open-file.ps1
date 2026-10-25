# The path is data; it is never interpolated into executable shell text.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $studioFile = $env:PRIME_STUDIO_OPEN_FILE
    if ([string]::IsNullOrWhiteSpace($studioFile) -or -not (Test-Path -LiteralPath $studioFile -PathType Leaf)) { throw 'File unavailable.' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudioFileShell {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr ShellExecuteW(IntPtr hwnd, string operation, string file, string parameters, string directory, int show);
}
'@
    $studioFolder = [IO.Path]::GetDirectoryName($studioFile)
    if ($env:PRIME_STUDIO_FILE_MODE -eq 'editor') {
        $studioEditor = Join-Path $env:SystemRoot 'System32\notepad.exe'
        $studioResult = [StudioFileShell]::ShellExecuteW([IntPtr]::Zero, 'open', $studioEditor, ('"' + $studioFile + '"'), $studioFolder, 1)
    } else {
        # SW_SHOWNORMAL: the document app is visible even when the helper is hidden.
        $studioResult = [StudioFileShell]::ShellExecuteW([IntPtr]::Zero, 'open', $studioFile, $null, $studioFolder, 1)
        # SE_ERR_NOASSOC (31): no associated application. Node classifies every
        # text-like type in PRIME_STUDIO_FILE_TEXT, so the helper needs no
        # extension list and never decides what counts as text.
        if ($studioResult.ToInt64() -eq 31 -and $env:PRIME_STUDIO_FILE_TEXT -eq '1') {
            $studioEditor = Join-Path $env:SystemRoot 'System32\notepad.exe'
            $studioResult = [StudioFileShell]::ShellExecuteW([IntPtr]::Zero, 'open', $studioEditor, ('"' + $studioFile + '"'), $studioFolder, 1)
        }
    }
    if ($studioResult.ToInt64() -le 32) { throw 'Shell did not accept the file.' }
    Write-Output '{"opened":true}'
    exit 0
} catch {
    [Console]::Error.WriteLine('The associated application could not open the file.')
    exit 1
}
