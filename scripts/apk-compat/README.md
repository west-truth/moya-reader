# APK compatibility feasibility tools

Developer-only, opt-in diagnostics. Not imported by the app and not a production extension loader.
See [evidence and next implementation steps](../../docs/project/0913-minimal-apk-runtime-spike.md).

Static inspection executes no APK code:

```sh
node scripts/apk-compat/inspect.mjs /path/to/trusted-manga.apk
node --test scripts/apk-compat/inspect.test.mjs
python -m unittest discover -s scripts/apk-compat -p 'test_*.py'
```

The manual runtime probe requires Python, JDK **21**, a trusted manga APK, its verified HttpSource class name,
and a local Suwayomi v2.3.2243 reference JAR (SHA-256 pinned in the tool). This reference is only a bytecode donor:
the generated runtime has no server/DB/downloader entry point. Nothing is downloaded automatically or added to the app.

```sh
python scripts/apk-compat/run-probe.py \
  --reference /path/to/reference.jar --apk /path/to/trusted-manga.apk \
  --entry org.example.manga.Source --jdk /path/to/jdk-21
```

The default is network-denied source construction. To deliberately test one public work/chapter/image, append
`--live --allow-host site.example --allow-host images.example`. Hostnames are exact HTTPS network grants; redirects
to unapproved hosts fail. The parent limits worker wall time and Java heap. JDK 21's deprecated SecurityManager is
only an additional diagnostic restriction, not the intended production security boundary. Do not use this tool as a
safe executor for untrusted APKs. SourceFactory, WebView and arbitrary preferences are not implemented in this probe.

Outputs go into a new local `.tmp/apk-compat-probe-*` directory. Logs may include source names, URLs and error snippets;
do not commit them or any APK/JARs. Extracted third-party bytecode is not a release artifact. Shipping requires an
independent reproducible dependency build and the associated license/source notices, plus OS isolation and lifecycle work.
