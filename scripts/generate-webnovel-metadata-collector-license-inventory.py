from __future__ import annotations

import argparse
from importlib import metadata
import json
from pathlib import Path
import re
import shutil
import sys


LICENSE_FILE_PATTERN = re.compile(r"^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$", re.IGNORECASE)


def normalized_component(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9._-]+", "-", value.lower()).strip("-.")
    return normalized or "unknown"


def declared_license(distribution: metadata.Distribution) -> str:
    expression = (distribution.metadata.get("License-Expression") or "").strip()
    if expression:
        return expression
    declared = (distribution.metadata.get("License") or "").strip()
    if declared and len(declared) <= 160 and "\n" not in declared:
        return declared
    classifiers = distribution.metadata.get_all("Classifier") or []
    known = (
        ("Apache Software License", "Apache-2.0"),
        ("MIT License", "MIT"),
        ("BSD License", "BSD"),
        ("Python Software Foundation License", "PSF-2.0"),
        ("Mozilla Public License 2.0", "MPL-2.0"),
        ("ISC License", "ISC"),
    )
    for classifier in classifiers:
        for marker, value in known:
            if marker in classifier:
                return value
    return "UNKNOWN"


def copy_distribution_licenses(distribution: metadata.Distribution, destination: Path) -> list[str]:
    copied: list[str] = []
    for relative in distribution.files or []:
        if not LICENSE_FILE_PATTERN.match(Path(str(relative)).name):
            continue
        source = distribution.locate_file(relative)
        if not source.is_file():
            continue
        destination.mkdir(parents=True, exist_ok=True)
        target = destination / Path(str(relative)).name
        suffix = 2
        while target.exists() and target.read_bytes() != source.read_bytes():
            target = destination / f"{source.stem}-{suffix}{source.suffix}"
            suffix += 1
        if not target.exists():
            shutil.copy2(source, target)
        copied.append(target.name)
    return sorted(set(copied))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--project-license", required=True, type=Path)
    arguments = parser.parse_args()

    if arguments.output_dir.exists():
        shutil.rmtree(arguments.output_dir)
    arguments.output_dir.mkdir(parents=True, exist_ok=True)

    components: list[dict[str, object]] = []
    for distribution in sorted(
        metadata.distributions(),
        key=lambda item: (item.metadata.get("Name") or "").lower(),
    ):
        name = distribution.metadata.get("Name") or "unknown"
        version = distribution.version or "unknown"
        component_dir = arguments.output_dir / f"{normalized_component(name)}-{normalized_component(version)}"
        license_files = copy_distribution_licenses(distribution, component_dir)
        if normalized_component(name) == "webnovel-metadata-collector":
            component_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(arguments.project_license, component_dir / "LICENSE")
            license_files = sorted(set([*license_files, "LICENSE"]))
        components.append(
            {
                "name": name,
                "version": version,
                "license": declared_license(distribution),
                "licenseFiles": [
                    f"third_party/licenses/python/{component_dir.name}/{file_name}" for file_name in license_files
                ],
            }
        )

    python_license = next(
        (candidate for candidate in [Path(sys.base_prefix) / "LICENSE.txt", Path(sys.base_prefix) / "LICENSE"] if candidate.is_file()),
        None,
    )
    python_dir = arguments.output_dir / f"python-{normalized_component(sys.version.split()[0])}"
    python_files: list[str] = []
    if python_license:
        python_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(python_license, python_dir / python_license.name)
        python_files.append(f"third_party/licenses/python/{python_dir.name}/{python_license.name}")
    components.append(
        {
            "name": "Python",
            "version": sys.version.split()[0],
            "license": "PSF-2.0",
            "licenseFiles": python_files,
        }
    )

    components.sort(key=lambda item: (str(item["name"]).lower(), str(item["version"])))
    inventory = {
        "format": "moya-webnovel-metadata-collector-python-inventory",
        "version": 1,
        "python": sys.version.split()[0],
        "componentCount": len(components),
        "unclassified": [component["name"] for component in components if component["license"] == "UNKNOWN"],
        "missingLicenseFiles": [component["name"] for component in components if not component["licenseFiles"]],
        "components": components,
    }
    arguments.inventory.parent.mkdir(parents=True, exist_ok=True)
    arguments.inventory.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote metadata collector license inventory: {len(components)} components, "
        f"{len(inventory['unclassified'])} unclassified, "
        f"{len(inventory['missingLicenseFiles'])} without copied license files"
    )
    if inventory["unclassified"] or inventory["missingLicenseFiles"]:
        raise SystemExit("metadata collector license inventory is incomplete")


if __name__ == "__main__":
    main()
