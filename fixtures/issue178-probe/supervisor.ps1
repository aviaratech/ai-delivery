# Throwaway issue178 probe. No Add-Type, compiler, policy bypass or target evaluation.
param(
    [ValidateSet('Supervise', 'Inspect')][string]$Mode = 'Supervise',
    [int]$TargetPid = 0,
    [string]$ExpectedBirth = '',
    [switch]$TerminateOwned
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$errStream = [Console]::OpenStandardError()
function Status($value) {
    $value.observedAtUtc = [DateTime]::UtcNow.ToString('o')
    $data = $utf8.GetBytes(($value | ConvertTo-Json -Depth 10 -Compress) + [char]10)
    $errStream.Write($data, 0, $data.Length)
    $errStream.Flush()
}
trap {
    Status @{ phase = 'probe-error'; errorType = $_.Exception.GetType().FullName; line = $_.InvocationInfo.ScriptLineNumber }
    exit 2
}
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
    [IntPtr]::Size -ne 8 -or $ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Status @{ phase = 'refused'; reason = 'requires-stock-ps51-x64-full-language' }
    exit 2
}
$self = [Diagnostics.Process]::GetCurrentProcess()
$selfIdentity = @{ pid = $PID; birth = $self.StartTime.ToFileTimeUtc().ToString() }
$control = $null
if ($Mode -eq 'Supervise') {
    # Awaiting the first packet is an initialization boundary with no target or compiler.
    Status @{ phase = 'bootstrap'; identity = $selfIdentity; language = 'FullLanguage'; ps = $PSVersionTable.PSVersion.ToString(); policy = (Get-ExecutionPolicy).ToString() }
    $control = [Console]::OpenStandardInput()
    $packet = New-Object IO.MemoryStream
    $one = New-Object byte[] 1
    while ($true) {
        $n = $control.Read($one, 0, 1)
        if ($n -eq 0) { Status @{ phase = 'complete'; reason = 'initialization-eof'; targetAdmitted = $false; jobCreated = $false }; exit 0 }
        if ($one[0] -eq 10) { break }
        if ($packet.Length -ge 65536) { Status @{ phase = 'refused'; reason = 'request-bound' }; exit 2 }
        $packet.WriteByte($one[0])
    }
    try { $request = $utf8.GetString($packet.ToArray()) | ConvertFrom-Json }
    catch { Status @{ phase = 'refused'; reason = 'request-format' }; exit 2 }
    $controlBuffer = New-Object byte[] 16
    # The base Stream async API keeps EOF/cancellation observable during native work.
    $controlTask = $control.ReadAsync($controlBuffer, 0, $controlBuffer.Length)
}

# Run-only Reflection.Emit: there is no CodeDOM or external csc.exe bootstrap.
$assemblyName = New-Object Reflection.AssemblyName('Issue178_' + [Guid]::NewGuid().ToString('N'))
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('Native')
$builder = $module.DefineType('Native', [Reflection.TypeAttributes]'Public,Sealed,Abstract')
$dll = [IO.Path]::Combine([Environment]::SystemDirectory, 'kernel32.dll')
$ptr = [IntPtr]; $u32 = [uint32]; $bool = [bool]; $str = [string]; $void = [void]; $uptr = [UIntPtr]
function Bind([string]$name, [Type]$ret, [Type[]]$parameters) {
    $method = $builder.DefinePInvokeMethod($name, $dll,
        [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',
        [Reflection.CallingConventions]::Standard, $ret, $parameters,
        [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $constructor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
    $attribute = [Activator]::CreateInstance([Reflection.Emit.CustomAttributeBuilder],
        [object[]]@($constructor, [object[]]@($dll),
            [Reflection.FieldInfo[]]@(
                [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
                [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),
                [Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'),
                [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling')),
            [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode,
                [Runtime.InteropServices.CallingConvention]::Winapi, $true)))
    $method.SetCustomAttribute($attribute)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
Bind 'CreateJobObjectW' $ptr @($ptr, $str)
Bind 'SetInformationJobObject' $bool @($ptr, [int], $ptr, $u32)
Bind 'QueryInformationJobObject' $bool @($ptr, [int], $ptr, $u32, $ptr)
Bind 'TerminateJobObject' $bool @($ptr, $u32)
Bind 'CreateProcessW' $bool @($str, $ptr, $ptr, $ptr, $bool, $u32, $ptr, $str, $ptr, $ptr)
Bind 'InitializeProcThreadAttributeList' $bool @($ptr, [int], $u32, $uptr.MakeByRefType())
Bind 'UpdateProcThreadAttribute' $bool @($ptr, $u32, $uptr, $ptr, $uptr, $ptr, $ptr)
Bind 'DeleteProcThreadAttributeList' $void @($ptr)
Bind 'CreateNamedPipeW' $ptr @($str, $u32, $u32, $u32, $u32, $u32, $u32, $ptr)
Bind 'CreateFileW' $ptr @($str, $u32, $u32, $ptr, $u32, $u32, $ptr)
Bind 'CreateEventW' $ptr @($ptr, $bool, $bool, $str)
Bind 'ResetEvent' $bool @($ptr)
Bind 'ReadFile' $bool @($ptr, $ptr, $u32, $u32.MakeByRefType(), $ptr)
Bind 'GetOverlappedResult' $bool @($ptr, $ptr, $u32.MakeByRefType(), $bool)
Bind 'CancelIoEx' $bool @($ptr, $ptr)
Bind 'WaitForSingleObject' $u32 @($ptr, $u32)
Bind 'GetExitCodeProcess' $bool @($ptr, $u32.MakeByRefType())
Bind 'GetProcessTimes' $bool @($ptr, $ptr, $ptr, $ptr, $ptr)
Bind 'OpenProcess' $ptr @($u32, $bool, $u32)
Bind 'IsProcessInJob' $bool @($ptr, $ptr, $bool.MakeByRefType())
Bind 'TerminateProcess' $bool @($ptr, $u32)
Bind 'CloseHandle' $bool @($ptr)
$native = $builder.CreateType()
if ($Mode -eq 'Supervise') { Status @{ phase = 'native-ready' } }
$lastNativeOperation = $null; $lastNativeReturned = $false; $lastNativeResult = $null; $lastNativeError = $null
function N([string]$name, [object[]]$arguments) {
    $script:lastNativeOperation = $name; $script:lastNativeReturned = $false; $script:lastNativeResult = $null; $script:lastNativeError = $null
    $result = $native.GetMethod($name).Invoke($null, $arguments)
    $script:lastNativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $script:lastNativeReturned = $true
    if ($result -is [bool] -or $result -is [uint32]) { $script:lastNativeResult = $result }
    elseif ($result -is [IntPtr]) { $script:lastNativeResult = $(if ($result -eq [IntPtr]::Zero) { 'zero-handle' } else { 'nonzero-handle' }) }
    return $result
}
function LastError { return $script:lastNativeError }
$allocations = New-Object 'System.Collections.Generic.List[System.IntPtr]'
$handles = New-Object 'System.Collections.Generic.List[System.IntPtr]'
function Alloc([int]$bytes) {
    $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes)
    $allocations.Add($p)
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $bytes), 0, $p, $bytes)
    return $p
}
function Handle($value) {
    if ($value -eq [IntPtr]::Zero -or $value.ToInt64() -eq -1) { throw 'native-handle' }
    $handles.Add($value)
    return $value
}
function Birth($h) {
    $times = Alloc 32
    if (-not (N 'GetProcessTimes' @($h, $times, [IntPtr]::Add($times, 8), [IntPtr]::Add($times, 16), [IntPtr]::Add($times, 24)))) { throw 'process-times' }
    return [Runtime.InteropServices.Marshal]::ReadInt64($times).ToString()
}
if ($Mode -eq 'Inspect') {
    $h = [IntPtr]::Zero; $same = $null; $waitStatus = $null
    try {
        if ($TargetPid -le 0 -or ($TerminateOwned -and $ExpectedBirth -notmatch '^[0-9]+$')) { throw 'identity-input' }
        $access = [uint32]0x101000
        if ($TerminateOwned) { $access = $access -bor 1 }
        $h = N 'OpenProcess' @($access, $false, [uint32]$TargetPid)
        if ($h -eq [IntPtr]::Zero) {
            $errorCode = LastError
            @{ pid = $TargetPid; state = $(if ($errorCode -eq 87) { 'absent' } else { 'unknown' }); errorCode = $errorCode } | ConvertTo-Json -Compress
        } else {
            $birth = Birth $h
            $same = $ExpectedBirth -eq '' -or $ExpectedBirth -eq $birth
            if ($TerminateOwned -and -not $same) { throw 'identity-changed' }
            $waitStatus = N 'WaitForSingleObject' @($h, [uint32]0)
            if ($TerminateOwned -and $waitStatus -eq 258) {
                if (-not (N 'TerminateProcess' @($h, [uint32]125))) { throw 'owned-terminate' }
                [void](N 'WaitForSingleObject' @($h, [uint32]3000))
                $waitStatus = N 'WaitForSingleObject' @($h, [uint32]0)
            }
            $waitError = LastError
            $state = $(if ($waitStatus -eq 0) { 'absent' } elseif ($waitStatus -eq 258) { 'alive' } else { 'unknown' })
            @{ pid = $TargetPid; birth = $birth; sameIdentity = $same; state = $state; terminated = [bool]$TerminateOwned;
                waitStatus = $waitStatus; errorCode = $(if ($waitStatus -eq [uint32]::MaxValue) { $waitError } else { $null }) } | ConvertTo-Json -Compress
        }
    } catch {
        @{ pid = $TargetPid; state = 'unknown'; error = 'identity-observation-failed';
            failureLine = $_.InvocationInfo.ScriptLineNumber; failureType = $_.Exception.GetType().FullName;
            sameIdentity = $same; waitStatus = $waitStatus; nativeOperation = $lastNativeOperation;
            nativeReturned = $lastNativeReturned; nativeResult = $lastNativeResult; nativeError = $lastNativeError } | ConvertTo-Json -Compress
    }
    finally {
        if ($h -ne [IntPtr]::Zero) { [void](N 'CloseHandle' @($h)) }
        foreach ($p in $allocations) { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
    }
    exit 0
}

$job = [IntPtr]::Zero; $process = [IntPtr]::Zero; $attributes = [IntPtr]::Zero; $attributeReady = $false
$reads = @(); $observed = @{}; $out = New-Object IO.MemoryStream
$totalBytes = 0L; $stderrBytes = 0L; $stdoutBytes = 0L
$reason = $null; $jobZero = $false; $admitted = $false; $rootExit = $null
$stopping = $false; $cleanupStart = $null; $safeToFree = $true
$failureLine = $null; $failureType = $null
$operationStage = 'request-admission'; $failureNative = $null
function Quote-Argument([string]$value) {
    # Windows CRT quoting only; this string is never evaluated by PowerShell/cmd.
    $b = New-Object Text.StringBuilder
    [void]$b.Append('"')
    $slashes = 0
    foreach ($c in $value.ToCharArray()) {
        if ($c -eq '\') { $slashes++; continue }
        if ($c -eq '"') { [void]$b.Append(('\' * ($slashes * 2 + 1))); [void]$b.Append('"') }
        else { [void]$b.Append(('\' * $slashes)); [void]$b.Append($c) }
        $slashes = 0
    }
    [void]$b.Append(('\' * ($slashes * 2))); [void]$b.Append('"')
    return $b.ToString()
}
function Pipe([string]$label, $security) {
    $name = '\\.\pipe\ai-delivery-178-' + [Guid]::NewGuid().ToString('N') + '-' + $label
    $read = Handle (N 'CreateNamedPipeW' @($name, [uint32]0x40080001, [uint32]8, [uint32]1, [uint32]4096, [uint32]4096, [uint32]0, [IntPtr]::Zero))
    # Client connection is established before any ReadFile. Only this write end inherits.
    $write = Handle (N 'CreateFileW' @($name, [uint32]0x40000000, [uint32]0, $security, [uint32]3, [uint32]0x80, [IntPtr]::Zero))
    $event = Handle (N 'CreateEventW' @([IntPtr]::Zero, $true, $false, $null))
    $ov = Alloc 32
    [Runtime.InteropServices.Marshal]::WriteIntPtr($ov, 24, $event)
    return [pscustomobject]@{ Label = $label; Read = $read; Write = $write; Event = $event; Ov = $ov; Buffer = (Alloc 4096); Pending = $false; Eof = $false }
}
function Capture($stream, [uint32]$count) {
    $script:totalBytes += $count
    if ($stream.Label -eq 'stdout') { $script:stdoutBytes += $count } else { $script:stderrBytes += $count }
    $remaining = [Math]::Max(0, 65536 - ($script:totalBytes - $count))
    if ($stream.Label -eq 'stdout' -and $remaining -gt 0) {
        $take = [Math]::Min([int]$count, [int]$remaining)
        $bytes = New-Object byte[] $take
        [Runtime.InteropServices.Marshal]::Copy($stream.Buffer, $bytes, 0, $take)
        $out.Write($bytes, 0, $take)
    }
    if ($script:totalBytes -gt 65536) { $script:reason = 'overflow' }
}
function Poll-Read($stream, [bool]$startNext) {
    if ($stream.Pending) {
        $a = [object[]]@($stream.Read, $stream.Ov, [uint32]0, $false)
        if (N 'GetOverlappedResult' $a) { $stream.Pending = $false; Capture $stream $a[2] }
        else {
            $e = LastError
            if ($e -eq 996) { return }
            $stream.Pending = $false
            if ($e -in @(109, 232, 995)) { $stream.Eof = $true }
            else { throw 'overlapped-completion' }
        }
    }
    if ($startNext -and -not $stream.Pending -and -not $stream.Eof) {
        [void](N 'ResetEvent' @($stream.Event))
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 32), 0, $stream.Ov, 32)
        [Runtime.InteropServices.Marshal]::WriteIntPtr($stream.Ov, 24, $stream.Event)
        $a = [object[]]@($stream.Read, $stream.Buffer, [uint32]4096, [uint32]0, $stream.Ov)
        if (N 'ReadFile' $a) { Capture $stream $a[3] }
        else {
            $e = LastError
            if ($e -eq 997) { $stream.Pending = $true }
            elseif ($e -in @(109, 232)) { $stream.Eof = $true }
            else { throw 'overlapped-read' }
        }
    }
}
try {
    $argv = @($request.argv)
    if ($argv.Count -lt 1 -or $argv.Count -gt 64 -or $argv[0] -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)' -or
        $argv[0] -notmatch '(?i)\.exe$' -or -not [IO.File]::Exists($argv[0])) { throw 'executable-admission' }
    foreach ($arg in $argv) { if ($arg -isnot [string] -or $arg.Contains([string][char]0)) { throw 'literal-argv' } }
    $line = ($argv | ForEach-Object { Quote-Argument $_ }) -join ' '
    if ($line.Length -ge 32767) { throw 'command-line-bound' }
    $deadline = [DateTime]::Parse($request.deadline).ToUniversalTime()
    if ([DateTime]::UtcNow -ge $deadline) { $reason = 'timeout'; throw 'response-deadline' }
    $environment = @{}
    foreach ($entry in $request.environment.PSObject.Properties) {
        if ($entry.Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $entry.Value -isnot [string] -or $entry.Value.Contains([string][char]0)) { throw 'environment-admission' }
        if ($environment.ContainsKey($entry.Name) -and $environment[$entry.Name] -cne $entry.Value) { throw 'environment-alias' }
        $environment[$entry.Name] = $entry.Value
    }
    $block = (($environment.Keys | Sort-Object | ForEach-Object { $_ + '=' + $environment[$_] }) -join [char]0) + [char]0 + [char]0
    $envPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($block); $allocations.Add($envPtr)
    $linePtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($line); $allocations.Add($linePtr)
    $job = Handle (N 'CreateJobObjectW' @([IntPtr]::Zero, $null))
    $limits = Alloc 144
    [Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x2000)
    if (-not (N 'SetInformationJobObject' @($job, 9, $limits, [uint32]144))) { throw 'job-limit-admission' }
    $security = Alloc 24
    [Runtime.InteropServices.Marshal]::WriteInt32($security, 0, 24)
    [Runtime.InteropServices.Marshal]::WriteInt32($security, 16, 1)
    $reads = @((Pipe 'stdout' $security), (Pipe 'stderr' $security))
    $nullInput = Handle (N 'CreateFileW' @('NUL', [uint32]2147483648, [uint32]3, $security, [uint32]3, [uint32]0x80, [IntPtr]::Zero))
    $a = [object[]]@([IntPtr]::Zero, 2, [uint32]0, [UIntPtr]::Zero)
    [void](N 'InitializeProcThreadAttributeList' $a)
    $attributes = Alloc ([int]$a[3].ToUInt64())
    $a[0] = $attributes
    if (-not (N 'InitializeProcThreadAttributeList' $a)) { throw 'attribute-admission' }
    $attributeReady = $true
    $jobArray = Alloc 8
    [Runtime.InteropServices.Marshal]::WriteIntPtr($jobArray, $job)
    $inherit = Alloc 24
    [Runtime.InteropServices.Marshal]::WriteIntPtr($inherit, 0, $nullInput)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($inherit, 8, $reads[0].Write)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($inherit, 16, $reads[1].Write)
    $operationStage = 'job-list-arguments'
    $lastNativeOperation = $null; $lastNativeReturned = $false; $lastNativeResult = $null; $lastNativeError = $null
    $a = [object[]]@($attributes, [uint32]0, [UIntPtr]0x2000d, $jobArray, [UIntPtr]8, [IntPtr]::Zero, [IntPtr]::Zero)
    $operationStage = 'job-list-call'
    $jobListAccepted = N 'UpdateProcThreadAttribute' $a
    $operationStage = 'job-list-return'
    if (-not $jobListAccepted) { throw 'job-list-admission' }
    $operationStage = 'handle-list-arguments'
    $lastNativeOperation = $null; $lastNativeReturned = $false; $lastNativeResult = $null; $lastNativeError = $null
    $a = [object[]]@($attributes, [uint32]0, [UIntPtr]0x20002, $inherit, [UIntPtr]24, [IntPtr]::Zero, [IntPtr]::Zero)
    $operationStage = 'handle-list-call'
    $handleListAccepted = N 'UpdateProcThreadAttribute' $a
    $operationStage = 'handle-list-return'
    if (-not $handleListAccepted) { throw 'handle-list-admission' }
    $startup = Alloc 112; $pi = Alloc 24
    [Runtime.InteropServices.Marshal]::WriteInt32($startup, 0, 112)
    [Runtime.InteropServices.Marshal]::WriteInt32($startup, 60, 0x100)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 80, $nullInput)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 88, $reads[0].Write)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 96, $reads[1].Write)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($startup, 104, $attributes)
    if ($controlTask.IsCompleted -or [DateTime]::UtcNow -ge $deadline) { $reason = 'pre-admission-control'; throw 'control-before-admission' }
    if (-not (N 'CreateProcessW' @($argv[0], $linePtr, [IntPtr]::Zero, [IntPtr]::Zero, $true, [uint32]0x8080400, $envPtr, [string]$request.cwd, $startup, $pi))) { throw 'atomic-create-admission' }
    $admitted = $true
    $process = Handle ([Runtime.InteropServices.Marshal]::ReadIntPtr($pi, 0))
    [void](Handle ([Runtime.InteropServices.Marshal]::ReadIntPtr($pi, 8)))
    $root = @{ pid = [Runtime.InteropServices.Marshal]::ReadInt32($pi, 16); birth = (Birth $process) }
    $observed[$root.pid] = $root
    foreach ($s in $reads) { [void](N 'CloseHandle' @($s.Write)); [void]$handles.Remove($s.Write) }
    Status @{ phase = 'admitted'; root = $root; atomicJobList = $true; inheritedHandles = 3; interpreterFallback = $false }
    $accounting = Alloc 48; $members = Alloc 4096
    while ($true) {
        if (-not $stopping -and $controlTask.IsCompleted) {
            $n = $controlTask.GetAwaiter().GetResult()
            $reason = $(if ($n -eq 0) { 'parent-eof' } else { 'cancel' })
        }
        if (-not $stopping -and -not $reason -and [DateTime]::UtcNow -ge $deadline) { $reason = 'timeout' }
        foreach ($s in $reads) { Poll-Read $s (-not $stopping -or $reason -in @('success', 'helper-exit')) }
        if (N 'QueryInformationJobObject' @($job, 3, $members, [uint32]4096, [IntPtr]::Zero)) {
            $count = [Runtime.InteropServices.Marshal]::ReadInt32($members, 4)
            if ($count -lt 0 -or $count -gt 511) { throw 'job-members-bound' }
            for ($i = 0; $i -lt $count; $i++) {
                $memberPid = [Runtime.InteropServices.Marshal]::ReadInt64($members, 8 + 8 * $i)
                if (-not $observed.ContainsKey($memberPid)) {
                    $h = N 'OpenProcess' @([uint32]0x101000, $false, [uint32]$memberPid)
                    if ($h -ne [IntPtr]::Zero) {
                        try {
                            # Enumeration is not ownership: the PID may have been reused before OpenProcess.
                            $membership = [object[]]@($h, $job, $false)
                            if (-not (N 'IsProcessInJob' $membership)) { throw 'job-membership-observation' }
                            if ($membership[2]) {
                                $identity = @{ pid = $memberPid; birth = (Birth $h) }
                                $observed[$memberPid] = $identity
                                Status @{ phase = 'member'; identity = $identity; membershipVerified = $true }
                            }
                        }
                        finally { [void](N 'CloseHandle' @($h)) }
                    }
                }
            }
        } else { throw 'job-members-observation' }
        if (-not $stopping -and -not $reason -and (N 'WaitForSingleObject' @($process, [uint32]0)) -eq 0) {
            $a = [object[]]@($process, [uint32]0)
            if (-not (N 'GetExitCodeProcess' $a)) { throw 'root-exit-observation' }
            $rootExit = $a[1]
            $reason = $(if ($rootExit -eq 0) { 'success' } else { 'helper-exit' })
        }
        if ($reason -and -not $stopping) {
            if (-not (N 'TerminateJobObject' @($job, [uint32]125))) { throw 'job-terminate' }
            $stopping = $true; $cleanupStart = [DateTime]::UtcNow
            if ($reason -notin @('success', 'helper-exit')) {
                foreach ($s in $reads) { if ($s.Pending) { [void](N 'CancelIoEx' @($s.Read, $s.Ov)) } else { $s.Eof = $true } }
            }
        }
        if (-not (N 'QueryInformationJobObject' @($job, 1, $accounting, [uint32]48, [IntPtr]::Zero))) { throw 'job-zero-observation' }
        $jobZero = [Runtime.InteropServices.Marshal]::ReadInt32($accounting, 40) -eq 0
        $settled = @($reads | Where-Object { $_.Pending -or -not $_.Eof }).Count -eq 0
        if ($stopping -and $jobZero -and $settled) { break }
        if ($stopping -and ([DateTime]::UtcNow - $cleanupStart).TotalMilliseconds -ge 3000) { $reason = 'cleanup-unknown'; break }
        Start-Sleep -Milliseconds 5
    }
} catch {
    $failureLine = $_.InvocationInfo.ScriptLineNumber
    $failureType = $_.Exception.GetType().FullName
    $failureNative = @{ stage = $operationStage; operation = $lastNativeOperation;
        returned = $lastNativeReturned; result = $lastNativeResult; errorCode = $lastNativeError; hresult = $_.Exception.HResult }
    if (-not $reason) { $reason = $(if ($admitted) { 'native-observation-failure' } else { 'admission-failure' }) }
    if ($job -ne [IntPtr]::Zero) { [void](N 'TerminateJobObject' @($job, [uint32]125)) }
    foreach ($s in $reads) { if ($s.Pending) { [void](N 'CancelIoEx' @($s.Read, $s.Ov)) } }
    $until = [DateTime]::UtcNow.AddMilliseconds(3000)
    while (@($reads | Where-Object { $_.Pending }).Count -gt 0 -and [DateTime]::UtcNow -lt $until) {
        foreach ($s in $reads) { try { Poll-Read $s $false } catch { } }
        Start-Sleep -Milliseconds 5
    }
    if ($job -ne [IntPtr]::Zero) {
        $proof = Alloc 48
        $jobZero = (N 'QueryInformationJobObject' @($job, 1, $proof, [uint32]48, [IntPtr]::Zero)) -and [Runtime.InteropServices.Marshal]::ReadInt32($proof, 40) -eq 0
    } else { $jobZero = -not $admitted }
} finally {
    $safeToFree = @($reads | Where-Object { $_.Pending }).Count -eq 0
    if ($attributeReady) { N 'DeleteProcThreadAttributeList' @($attributes) }
    if ($safeToFree) {
        foreach ($h in $handles) { [void](N 'CloseHandle' @($h)) }
        foreach ($p in $allocations) { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
    }
    # If I/O is unresolved, retain its buffers/handles until process teardown; never free early.
    if (-not $safeToFree) { $reason = 'cleanup-unknown' }
}
$bytes = $out.ToArray()
$stdout = [Console]::OpenStandardOutput()
$stdout.Write($bytes, 0, $bytes.Length); $stdout.Flush()
Status @{ phase = 'complete'; reason = $reason; supervisor = $selfIdentity; targetAdmitted = $admitted;
    jobCreated = ($job -ne [IntPtr]::Zero); jobZero = $jobZero; pendingReadsSettled = $safeToFree;
    rootExit = $rootExit; capturedBytes = $totalBytes; stdoutBytes = $stdoutBytes; stderrBytes = $stderrBytes;
    retainedStdoutBytes = $bytes.Length; observed = @($observed.Values); processRssBytes = $self.WorkingSet64;
    failureLine = $failureLine; failureType = $failureType; failureNative = $failureNative }
if ($reason -eq 'success' -and $jobZero -and $safeToFree) { exit 0 }
exit 2
