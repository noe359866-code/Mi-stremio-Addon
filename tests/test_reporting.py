import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from analyzer import analyze
from reporting import write_reports


def sample(content):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        z.writestr('AndroidManifest.xml', 'android.permission.CAMERA')
        z.writestr('assets/=malicious.html', content)
    return analyze(stream.getvalue(), 'sample.apk')


class ReportsTests(unittest.TestCase):
    def test_categories_and_ports(self):
        r = sample(b'http://localhost:8080/api/test https://example.org/image.png wss://example.org/ws')
        self.assertEqual(r['summary']['possible_apis'], 1)
        self.assertEqual(r['summary']['without_tls'], 1)
        self.assertEqual(r['summary']['sensitive_permissions'], 1)
        self.assertIn('http://localhost:8080/api/test', [u['url'] for u in r['urls']])
        self.assertEqual(len(r['domains']), 2)
        self.assertEqual(len(r['findings']), 1)

    def test_wide_strings_and_escaped_slashes(self):
        r = sample('https://wide.example/api/test'.encode('utf-16le') + b'\nhttps:\\/\\/escaped.example/v1/test')
        self.assertEqual(len(r['urls']), 2)

    def test_html_escaping_and_csv(self):
        r = sample(b'https://example.org/api/test')
        r['warnings'] = ['<script>alert(1)</script>']
        r['urls'][0]['files'] = ['=FORMULA()']
        with tempfile.TemporaryDirectory() as d:
            write_reports(r, d)
            page = (Path(d)/'report.html').read_text()
            self.assertNotIn('<script>', page)
            self.assertIn('&lt;script&gt;', page)
            self.assertIn("'=FORMULA()", (Path(d)/'connections.csv').read_text(encoding='utf-8-sig'))

    def test_bad_port_ignored(self):
        self.assertEqual(sample(b'https://example.org:invalid/api')['urls'], [])
