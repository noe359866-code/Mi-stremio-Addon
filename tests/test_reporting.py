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

    def test_xml_namespace_is_not_cleartext_traffic(self):
        r = sample(b'http://schemas.android.com/apk/res/android')
        self.assertEqual(r['urls'][0]['category'], 'Metadatos XML')
        self.assertEqual(r['summary']['without_tls'], 0)
        self.assertEqual(r['findings'], [])


class StructuredReportTests(unittest.TestCase):
    def _structured(self):
        import io as _io
        from fixtures import manifest_tree, axml_bytes, dex_bytes, der_cert, pkcs7
        manifest = axml_bytes(manifest_tree(
            package='com.report.app', permissions=['android.permission.INTERNET'],
            application={'debuggable': True},
            components=[{'type': 'activity', 'name': '.MainActivity', 'exported': True}]))
        out = _io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('AndroidManifest.xml', manifest)
            z.writestr('classes.dex', dex_bytes(['https://www.google-analytics.com/collect', 'https://api.example.com/v1/movies']))
            z.writestr('META-INF/CERT.SF', 'x')
            z.writestr('META-INF/CERT.RSA', pkcs7(der_cert(subject_cn='Android Debug', issuer_cn='Android Debug')))
        return analyze(out.getvalue(), 'report.apk')

    def test_summary_and_sdks(self):
        r = self._structured()
        self.assertEqual(r['summary']['declared_permissions'], 1)
        self.assertEqual(r['summary']['components'], 1)
        self.assertEqual(r['summary']['exported_components'], 1)
        self.assertEqual(r['summary']['known_sdks'], 1)
        self.assertEqual(r['sdks'][0]['sdk'], 'Google Analytics')

    def test_html_sections_present_and_escaped(self):
        r = self._structured()
        r['manifest']['package'] = '<script>alert(1)</script>'
        with tempfile.TemporaryDirectory() as d:
            write_reports(r, d)
            page = (Path(d) / 'report.html').read_text()
            for anchor in ('id="manifest"', 'id="components"', 'id="signature"', 'id="sdks"'):
                self.assertIn(anchor, page)
            self.assertNotIn('<script>alert(1)</script>', page)
            self.assertIn('&lt;script&gt;', page)
            self.assertIn('Android Debug', page)

    def test_debug_findings(self):
        r = self._structured()
        types = [f['type'] for f in r['findings']]
        self.assertIn('Aplicación depurable (android:debuggable)', types)
        self.assertIn('Componente exportado sin permiso', types)
        self.assertIn('Firmado con certificado de depuración', types)
