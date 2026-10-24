# The runner, its arguments and the working folder arrive as data through
# environment variables; they are never interpolated into executable shell text.
# This helper always opens a real visible console, so it must stay
# unreachable except through the project-files run route (full control only,
# never read-only).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $studioExe = $env:PRIME_STUDIO_RUN_EXE
    $studioArgs = $env:PRIME_STUDIO_RUN_ARGS
    $studioFolder = $env:PRIME_STUDIO_RUN_FOLDER
    if ([string]::IsNullOrWhiteSpace($studioExe) -or -not (Test-Path -LiteralPath $studioExe -PathType Leaf)) { throw 'Runner unavailable.' }
    if ([string]::IsNullOrWhiteSpace($studioFolder) -or -not (Test-Path -LiteralPath $studioFolder -PathType Container)) { throw 'Folder unavailable.' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudioRunShell {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr ShellExecuteW(IntPtr hwnd, string operation, string file, string parameters, string directory, int show);
}
'@
    $studioRoot = [IO.Path]::GetFullPath($studioFolder)
    # SW_SHOWNORMAL: a new visible console window that stays open after the
    # script ends, even when the helper itself stays hidden.
    $studioResult = [StudioRunShell]::ShellExecuteW([IntPtr]::Zero, 'open', $studioExe, $studioArgs, $studioRoot, 1)
    if ($studioResult.ToInt64() -le 32) { throw 'Shell did not accept the script.' }
    Write-Output '{"ran":true}'
    exit 0
} catch {
    [Console]::Error.WriteLine('The script could not be started on this PC.')
    exit 1
}
