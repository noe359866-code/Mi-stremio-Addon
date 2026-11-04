import io
import unittest
import zipfile
from analyzer import analyze

def apk(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        for name, data in files.items():
            z.writestr(name, data)
    return out.getvalue()

class AnalysisTests(unittest.TestCase):
    def test_finds_and_redacts(self):
        result = analyze(apk({'AndroidManifest.xml': 'android.permission.INTERNET', 'classes.dex': 'https://example.com/api?token=private api_key="abcdefghijklmnop"'}), 'test.apk')
        self.assertEqual(result['urls'][0]['url'], 'https://example.com/api')
        self.assertEqual(result['permissions'], ['android.permission.INTERNET'])
        self.assertEqual(len(result['secrets']), 1)
        self.assertNotIn('abcdefghijklmnop', str(result))
        self.assertNotIn('token=private', str(result))
    def test_invalid_archive(self):
        with self.assertRaises(ValueError): analyze(b'bad', 'test.apk')
    def test_missing_manifest(self):
        with self.assertRaises(ValueError): analyze(apk({'a':'b'}), 'test.apk')
    def test_no_extract(self):
        result = analyze(apk({'AndroidManifest.xml':'', '../../evil': 'https://example.org/test'}), 'test.apk')
        self.assertEqual(len(result['urls']), 1)

class StructuredIntegrationTests(unittest.TestCase):
    def _apk(self, manifest, dex=None, cert=None):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('AndroidManifest.xml', manifest)
            if dex is not None:
                z.writestr('classes.dex', dex)
            if cert is not None:
                z.writestr('META-INF/CERT.SF', 'Signature-Version: 1.0')
                z.writestr('META-INF/CERT.RSA', cert)
        return out.getvalue()

    def test_manifest_dex_and_signature(self):
        from fixtures import manifest_tree, axml_bytes, dex_bytes, der_cert, pkcs7
        manifest = axml_bytes(manifest_tree(
            package='com.structured.app',
            permissions=['android.permission.INTERNET'],
            application={'debuggable': True, 'usesCleartextTraffic': True},
            components=[{'type': 'activity', 'name': '.MainActivity', 'exported': True,
                         'intent_filters': [{'actions': ['android.intent.action.VIEW'],
                                             'categories': ['android.intent.category.BROWSABLE'],
                                             'data': [{'scheme': 'https', 'host': 'example.com'}]}]}]))
        dex = dex_bytes(['https://api.example.com/v1/catalog', 'Lcom/structured/Main;'])
        cert = pkcs7(der_cert(subject_cn='Android Debug', issuer_cn='Android Debug'))
        result = analyze(self._apk(manifest, dex, cert), 'structured.apk')
        self.assertEqual(result['manifest']['package'], 'com.structured.app')
        self.assertEqual(result['manifest']['permissions_declared'], ['android.permission.INTERNET'])
        self.assertEqual(len(result['manifest']['deep_links']), 1)
        self.assertEqual(result['dex'][0]['strings_read'], 2)
        self.assertTrue(result['signature']['v1'])
        self.assertTrue(result['signature']['certificates'][0]['debug_certificate'])
        self.assertIn('https://api.example.com/v1/catalog', [u['url'] for u in result['urls']])
        types = [f['type'] for f in result['findings']]
        self.assertIn('Aplicación depurable (android:debuggable)', types)
        self.assertIn('Componente exportado sin permiso', types)
        self.assertIn('Firmado con certificado de depuración', types)
        self.assertEqual(result['schema_version'], '3.0')

    def test_multidex(self):
        from fixtures import dex_bytes
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('AndroidManifest.xml', 'android.permission.INTERNET')
            z.writestr('classes.dex', dex_bytes(['https://one.example/api']))
            z.writestr('classes2.dex', dex_bytes(['https://two.example/api']))
        result = analyze(out.getvalue(), 'multidex.apk')
        self.assertEqual(len(result['dex']), 2)
        self.assertEqual({u['url'] for u in result['urls']}, {'https://one.example/api', 'https://two.example/api'})

    def test_new_secret_patterns_redacted(self):
        google_key = 'AIza' + 'A' * 35
        content = 'https://example.com/api ' + google_key + ' -----BEGIN RSA PRIVATE KEY-----'
        result = analyze(apk({'AndroidManifest.xml': 'x', 'assets/config.txt': content}), 'secrets.apk')
        types = {s['type'] for s in result['secrets']}
        self.assertIn('Clave API de Google', types)
        self.assertIn('Clave privada', types)
        self.assertNotIn(google_key, str(result))
        self.assertTrue(all(s['value'] == '•••••••• (oculto)' for s in result['secrets']))

    def test_plain_manifest_fallback(self):
        result = analyze(apk({'AndroidManifest.xml': 'android.permission.CAMERA https://plain.example/api'}), 'plain.apk')
        self.assertIsNone(result['manifest'])
        self.assertTrue(any('Manifiesto no estructurado' in w for w in result['warnings']))
        self.assertIn('https://plain.example/api', [u['url'] for u in result['urls']])


if __name__ == '__main__': unittest.main()
