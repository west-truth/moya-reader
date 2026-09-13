"""Manual JDK 21 feasibility probe. Generated third-party artifacts are private .tmp diagnostics, not a shipped runtime."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import zipfile

ROOT = Path(__file__).resolve().parents[2]
REFERENCE_SHA256 = '821141b32e170d4a02d3cbdfed577ed8f07bd22383ff5f4132ebb5ae40e98dd5'
RUNTIME_PREFIXES = (
    'eu/kanade/tachiyomi/source/', 'eu/kanade/tachiyomi/network/', 'eu/kanade/tachiyomi/util/',
    'android/', 'androidx/', 'kotlin/', 'kotlinx/', 'okhttp3/', 'okio/', 'rx/', 'uy/',
    'org/jsoup/', 'org/json/', 'org/jetbrains/', 'org/koin/', 'org/slf4j/', 'org/xmlpull/',
)
CONVERTER_PREFIXES = ('com/googlecode/dex2jar/', 'com/googlecode/d2j/', 'org/objectweb/asm/')
PURE_HELPER = 'suwayomi/tachidesk/manga/impl/util/lang/JsonObjectKt.class'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def select_entry(name):
    if name.endswith('/'):
        return None
    if name == PURE_HELPER:
        return 'runtime'
    if name.startswith(('eu/kanade/tachiyomi/source/local/', 'suwayomi/', 'io/javalin/', 'org/jetbrains/exposed/')):
        return None
    if name.startswith(CONVERTER_PREFIXES):
        return 'converter'
    if name.startswith(RUNTIME_PREFIXES):
        return 'runtime'
    return None


def run(command, output, timeout=30):
    result = subprocess.run(command, cwd=output, capture_output=True, timeout=timeout,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        (output / 'failed-step.txt').write_bytes(result.stdout + result.stderr)
        raise RuntimeError('Probe step failed; see private failed-step.txt')
    return result


def parse_metrics(stdout):
    metrics = {}
    for line in stdout.decode('utf-8', 'replace').splitlines():
        match = re.fullmatch(r'(loaded|sourceCount|loadMs|works|chapters|pages|imageBytes|imageVerified|heapUsedBytes|totalMs)=(true|\d+)', line)
        if match:
            key, value = match.groups()
            metrics[key] = True if value == 'true' else int(value)
    return metrics


def windows_peak(pid):
    if os.name != 'nt':
        return None
    class Counters(ctypes.Structure):
        _fields_ = [('cb', ctypes.c_ulong), ('PageFaultCount', ctypes.c_ulong)] + [
            (name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
                'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage')]
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x410, False, pid)
    if not handle:
        return None
    try:
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        fn = ctypes.windll.psapi.GetProcessMemoryInfo
        fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
        return counters.PeakWorkingSetSize if fn(handle, ctypes.byref(counters), counters.cb) else None
    finally:
        kernel.CloseHandle(handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, required=True, help='Local v2.3.2243 reference jar; never executed as a server')
    parser.add_argument('--apk', type=Path, required=True, help='Trusted local manga APK; never uploaded')
    parser.add_argument('--entry', required=True, help='Verified APK source class (HttpSource subclass)')
    parser.add_argument('--source-id', default='', help='Optional decimal source ID inside a SourceFactory')
    parser.add_argument('--jdk', type=Path, required=True, help='JDK 21 home')
    parser.add_argument('--live', action='store_true', help='Read one public work/chapter/image using the APK')
    parser.add_argument('--allow-host', action='append', default=[], help='Exact HTTPS hostname allowed during this probe')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z_$][A-Za-z0-9_$.]*', args.entry):
        raise ValueError('invalid_entry_class')
    if args.source_id and not re.fullmatch(r'[1-9][0-9]{0,18}', args.source_id):
        raise ValueError('invalid_source_id')
    if any(not re.fullmatch(r'[A-Za-z0-9.-]+', host) for host in args.allow_host):
        raise ValueError('invalid_host')
    if args.live != bool(args.allow_host):
        raise ValueError('Live mode requires explicit --allow-host; offline mode forbids hosts')
    reference, apk, jdk = args.reference.resolve(), args.apk.resolve(), args.jdk.resolve()
    if reference.stat().st_size > 200 * 1024 * 1024 or digest(reference) != REFERENCE_SHA256:
        raise ValueError('reference_version_or_hash_mismatch')
    if apk.stat().st_size > 32 * 1024 * 1024:
        raise ValueError('apk_size_limit')
    java, javac = jdk / 'bin' / ('java.exe' if os.name == 'nt' else 'java'), jdk / 'bin' / ('javac.exe' if os.name == 'nt' else 'javac')
    version = subprocess.run([java, '-version'], capture_output=True, check=True)
    if not re.search(rb'version "21[.\"]', version.stderr):
        raise ValueError('diagnostic_requires_jdk21')
    output = ROOT / '.tmp' / f'apk-compat-probe-{time.time_ns()}'
    output.mkdir(parents=True)
    classes = output / 'classes'
    classes.mkdir()
    shutil.copyfile(apk, output / 'source.apk')
    selected = []
    with zipfile.ZipFile(reference) as donor, zipfile.ZipFile(output / 'runtime.jar', 'w', zipfile.ZIP_DEFLATED) as runtime, zipfile.ZipFile(output / 'converter.jar', 'w', zipfile.ZIP_DEFLATED) as converter:
        for entry in donor.infolist():
            target = select_entry(entry.filename)
            if target:
                if entry.file_size > 32 * 1024 * 1024:
                    raise ValueError('reference_entry_limit')
                (runtime if target == 'runtime' else converter).writestr(entry.filename, donor.read(entry))
                selected.append(entry.filename)
    (output / 'reference-entries.json').write_text(json.dumps(selected, indent=2), encoding='utf-8')
    classpath = os.pathsep.join(str(output / name) for name in ('runtime.jar', 'converter.jar'))
    # Keeping Kotlin's '-' method names is required for its binary ABI (e.g. Result.constructor-impl).
    run([java, '-Xmx256m', '-cp', classpath, 'com.googlecode.dex2jar.tools.Dex2jarCmd', 'source.apk', '-o', 'source.jar', '-f', '-dsn'], output)
    sources = sorted((ROOT / 'scripts/apk-compat/java').rglob('*.java'))
    run([javac, '-cp', str(output / 'runtime.jar'), '-d', str(classes), *map(str, sources)], output)
    def policy_path(path):
        value = path.as_posix()
        if '"' in value:
            raise ValueError('unsupported_policy_path')
        return value
    policy = ['grant {',
        f'permission java.io.FilePermission "{policy_path(output)}/-", "read";',
        f'permission java.io.FilePermission "{policy_path(jdk)}/-", "read";',
        'permission java.util.PropertyPermission "*", "read";',
        'permission java.net.NetPermission "getProxySelector";',
        'permission java.lang.RuntimePermission "accessDeclaredMembers";',
        'permission java.lang.RuntimePermission "modifyThread";',
        'permission java.lang.RuntimePermission "modifyThreadGroup";',
        'permission java.lang.reflect.ReflectPermission "suppressAccessChecks";',
    ]
    policy += [f'permission java.net.SocketPermission "{host}:443", "connect,resolve";' for host in args.allow_host]
    (output / 'probe.policy').write_text('\n'.join(policy + ['};']), encoding='utf-8')
    command = [java, '-Xmx128m', '-Djava.security.manager', f'-Djava.security.policy=={output / "probe.policy"}',
        '-cp', os.pathsep.join(str(output / name) for name in ('classes', 'runtime.jar', 'source.jar')), 'Probe', args.entry]
    command += ['live' if args.live else 'offline', args.source_id]
    started = time.monotonic()
    child = subprocess.Popen(command, cwd=output, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    peak = None
    try:
        while True:
            sample = windows_peak(child.pid)
            if sample is not None:
                peak = max(peak or 0, sample)
            try:
                stdout, stderr = child.communicate(timeout=0.05)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() - started > 75:
                    raise TimeoutError('probe_deadline')
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate()
    # Raw diagnostics can include source URLs/class names; stay in private .tmp only.
    (output / 'stdout.txt').write_bytes(stdout)
    (output / 'stderr.txt').write_bytes(stderr)
    metrics = parse_metrics(stdout)
    report = {'status': 'pass' if child.returncode == 0 and metrics.get('loaded') and (not args.live or metrics.get('imageVerified')) else 'failed',
        'referenceSha256': REFERENCE_SHA256, 'apkSha256': digest(apk), 'runtimeBytes': (output / 'runtime.jar').stat().st_size,
        'converterBytes': (output / 'converter.jar').stat().st_size, 'windowsPeakWorkingSetBytes': peak,
        'wallMs': round((time.monotonic() - started) * 1000), 'live': args.live, 'exitCode': child.returncode, 'metrics': metrics}
    (output / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))
    print(f'Diagnostics: {output}')
    if report['status'] != 'pass':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
