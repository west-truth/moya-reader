import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('run-probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeBoundaryTests(unittest.TestCase):
    def test_keeps_server_ui_database_and_local_library_out(self):
        for name in ('suwayomi/tachidesk/server/Main.class', 'io/javalin/Javalin.class',
                     'org/jetbrains/exposed/sql/Table.class', 'eu/kanade/tachiyomi/source/local/LocalSource.class',
                     'webUI/index.html', 'org/postgresql/Driver.class'):
            self.assertIsNone(probe.select_entry(name))
        self.assertEqual(probe.select_entry(probe.PURE_HELPER), 'runtime')

    def test_converter_is_not_a_runtime_dependency(self):
        self.assertEqual(probe.select_entry('com/googlecode/dex2jar/tools/Dex2jarCmd.class'), 'converter')
        self.assertEqual(probe.select_entry('eu/kanade/tachiyomi/source/online/HttpSource.class'), 'runtime')

    def test_metrics_are_allowlisted_and_accept_windows_newlines(self):
        expected = {'loaded': True, 'loadMs': 250, 'imageVerified': True, 'imageBytes': 10161}
        text = b'loaded=true\nloadMs=250\nimageVerified=true\nimageBytes=10161\nprivateUrl=https://example.test\n'
        self.assertEqual(probe.parse_metrics(text), expected)
        self.assertEqual(probe.parse_metrics(text.replace(b'\n', b'\r\n')), expected)


if __name__ == '__main__':
    unittest.main()
