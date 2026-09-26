"""Fetch pinned third-party sources and package them beside the Windows candidate.

This preserves source evidence; it is not a replacement for the artifact release audit.
No credentials, local profiles, or build caches enter the archive.
"""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / '.tmp/windows-source-cache')
    parser.add_argument('--output', type=Path, default=ROOT / '.tmp/windows-beta')
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / 'third_party/windows-source-manifest.json').read_text())
    cargo = json.loads((ROOT / 'third_party/windows-cargo-inventory.json').read_text())
    if digest(ROOT / 'src-tauri/Cargo.lock') != cargo['cargoLockSha256']:
        raise RuntimeError('Cargo.lock changed: refresh the Windows inventory before packaging')
    for component in cargo['components']:
        if not component['notices']:
            raise RuntimeError(f"Missing notice: {component['name']}")
        for notice in component['notices']:
            if digest(ROOT / notice['file']) != notice['sha256']:
                raise RuntimeError(f"Notice changed: {notice['file']}")
    names = [row['file'] for row in manifest['sources']]
    if len(set(names)) != len(names) or any(Path(name).name != name for name in names):
        raise RuntimeError('Source filenames must be unique basenames')

    def fetch(row):
        target = args.cache / row['file']
        if not target.exists() or digest(target) != row['sha256']:
            temporary = target.with_name(target.name + '.partial')
            try:
                with urllib.request.urlopen(row['url'], timeout=120) as response, temporary.open('wb') as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                if digest(temporary) != row['sha256']:
                    raise RuntimeError(f"Source checksum mismatch: {row['component']}")
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        return target

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
        sources = list(workers.map(fetch, manifest['sources']))
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    project = args.output / f'moya-source-{commit[:7]}.tar.gz'
    subprocess.run(['git', 'archive', '--format=tar.gz', f'--output={project.resolve()}', 'HEAD'], cwd=ROOT, check=True)
    bundle = args.output / f'moya-windows-sources-{commit[:7]}.tar.gz'
    with tarfile.open(bundle, 'w:gz', compresslevel=1) as archive:
        archive.add(project, arcname=project.name)
        for source in sources:
            archive.add(source, arcname='sources/' + source.name)
        for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'third_party/windows-source-manifest.json',
                     'third_party/windows-cargo-inventory.json', 'third_party/windows-sources.md', 'third_party/licenses']:
            archive.add(ROOT / name, arcname=name)
    project.unlink()
    checksum = f'{digest(bundle)}  {bundle.name}\n'
    bundle.with_suffix(bundle.suffix + '.sha256').write_text(checksum)
    print(f'Checked {len(sources)} source archives and {len(cargo["components"])} Cargo notices')
    print(bundle)
    print(checksum, end='')


if __name__ == '__main__':
    main()
