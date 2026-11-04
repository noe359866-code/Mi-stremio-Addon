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

if __name__ == '__main__': unittest.main()
