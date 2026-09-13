"""Build the minimal source API from pinned source, never from a server distribution."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
UPSTREAM = 'https://codeload.github.com/Suwayomi/Suwayomi-Server/zip/refs/tags/v2.3.2243'
SOURCE_SHA256 = 'e70f664013e83d49fee66ab5f83b6f281d956560c5a8baeba1d00b417048efb2'
NETWORK = {'HttpException.kt', 'OkHttpExtensions.kt', 'ProgressListener.kt', 'ProgressResponseBody.kt', 'Requests.kt', 'MemoryCookieJar.kt'}
HELPERS = {'suwayomi/tachidesk/manga/impl/util/lang/JsonObject.kt', 'suwayomi/tachidesk/manga/impl/util/lang/RxCoroutineBridge.kt'}


def select_source(path):
    return (path.startswith('eu/kanade/tachiyomi/source/') and '/local/' not in path
            or path.startswith('eu/kanade/tachiyomi/network/') and Path(path).name in NETWORK
            or path == 'eu/kanade/tachiyomi/util/JsoupExtensions.kt' or path in HELPERS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--maven', default='mvn')
    parser.add_argument('--source-archive', type=Path, help='Optional cached archive; hash is still mandatory')
    args = parser.parse_args()
    build = HERE / 'build'
    build.mkdir(exist_ok=True)
    archive = args.source_archive or build / 'upstream.zip'
    if not archive.exists():
        with urllib.request.urlopen(UPSTREAM, timeout=90) as response:
            data = response.read(64 * 1024 * 1024 + 1)
        if len(data) > 64 * 1024 * 1024:
            raise ValueError('upstream_size_limit')
        archive.write_bytes(data)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError('upstream_hash_mismatch')
    # Only generated sources are replaced. User data and installed APKs are outside the build root.
    sources = build / 'src'
    if sources.exists():
        if sources.resolve().parent != build.resolve():
            raise ValueError('invalid_build_path')
        shutil.rmtree(sources)
    selected = []
    with zipfile.ZipFile(archive) as upstream:
        for entry in upstream.infolist():
            android_marker = '/AndroidCompat/src/main/java/'
            if android_marker in entry.filename and entry.filename.endswith('.java'):
                relative = entry.filename.split(android_marker, 1)[1]
                if relative.startswith('androidx/preference/') or relative in {'android/annotation/NonNull.java', 'android/annotation/Nullable.java'}:
                    target = sources / 'main/java' / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(upstream.read(entry))
                    selected.append('AndroidCompat/' + relative)
            marker = '/server/src/main/kotlin/'
            if marker not in entry.filename or not entry.filename.endswith('.kt'):
                continue
            relative = entry.filename.split(marker, 1)[1]
            if not select_source(relative):
                continue
            target = sources / 'main/kotlin' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(upstream.read(entry))
            selected.append(relative)
        license_path = next(name for name in upstream.namelist() if name.endswith('/LICENSE'))
        (build / 'UPSTREAM-LICENSE').write_bytes(upstream.read(license_path))
    # Extend the pinned preference compatibility layer without bundling the server UI.
    preference = sources / 'main/java/androidx/preference/Preference.java'
    text = preference.read_text(encoding='utf-8')
    old = 'public void setOnPreferenceClickListener(OnPreferenceClickListener onPreferenceClickListener) {\n        throw new RuntimeException("Stub!");\n    }'
    if old not in text:
        raise ValueError('preference_compatibility_source_changed')
    text = text.replace(old, 'public void setOnPreferenceClickListener(OnPreferenceClickListener listener) { /* Android UI action: not invoked by the settings bridge. */ }')
    preference.write_text(text, encoding='utf-8')
    for name, replacements in {
        'TwoStatePreference.java': {
            'public boolean isChecked() { throw new RuntimeException("Stub!"); }': 'public boolean isChecked() { return Boolean.TRUE.equals(getCurrentValue()); }',
            'public void setChecked(boolean checked) { throw new RuntimeException("Stub!"); }': 'public void setChecked(boolean checked) { setDefaultValue(checked); }',
        },
        'ListPreference.java': {
            'public String getValue() { throw new RuntimeException("Stub!"); }': 'public String getValue() { return (String) getCurrentValue(); }',
            'public void setValue(String value) { throw new RuntimeException("Stub!"); }': 'public void setValue(String value) { setDefaultValue(value); }',
        },
    }.items():
        path = preference.parent / name
        text = path.read_text(encoding='utf-8')
        for old, new in replacements.items():
            if old not in text:
                raise ValueError('preference_compatibility_source_changed')
            text = text.replace(old, new)
        path.write_text(text, encoding='utf-8')
    shutil.copytree(HERE / 'java', sources / 'main/java', dirs_exist_ok=True)
    if (HERE / 'kotlin').exists():
        shutil.copytree(HERE / 'kotlin', sources / 'main/kotlin', dirs_exist_ok=True)
    shutil.copyfile(HERE / 'pom.xml', build / 'pom.xml')
    dependencies_directory = build / 'dependencies'
    if dependencies_directory.exists():
        if dependencies_directory.resolve().parent != build.resolve():
            raise ValueError('invalid_build_path')
        shutil.rmtree(dependencies_directory)
    subprocess.run([str(Path(args.maven).resolve()) if Path(args.maven).exists() else args.maven,
                    '-B', '-f', str(build / 'pom.xml'), 'clean', 'package', 'dependency:copy-dependencies',
                    '-DoutputDirectory=dependencies', '-DskipTests'], check=True, timeout=600)
    dependencies = sorted((build / 'dependencies').glob('*.jar'))
    inventory = {'sourceArchive': UPSTREAM, 'sourceSha256': SOURCE_SHA256, 'sources': selected,
                 'dependencies': [{'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in dependencies]}
    expected = json.loads((HERE / 'dependencies.lock.json').read_text(encoding='utf-8'))
    if inventory['dependencies'] != expected:
        raise ValueError('dependency_lock_mismatch')
    (build / 'build-inventory.json').write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')
    java = str(Path(os.environ['JAVA_HOME']) / 'bin' / ('java.exe' if os.name == 'nt' else 'java')) if os.environ.get('JAVA_HOME') else 'java'
    classpath = os.pathsep.join([str(build / 'target/apk-worker-0.1.0.jar'), str(build / 'dependencies/*')])
    for test in ['AndroidDispatcherSmoke.java', 'NetworkSessionSmoke.java', 'PreferencesSmoke.java', 'FiltersSmoke.java']:
        subprocess.run([java, '-cp', classpath, str(HERE / 'test' / test)], check=True, timeout=15)
    print('Minimal APK worker built. No server/DB/WebUI included.')


if __name__ == '__main__':
    main()
