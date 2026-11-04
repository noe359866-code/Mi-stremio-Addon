import unittest
from axml import parse_manifest, parse_axml, arsc_strings, read_string_pool
from fixtures import manifest_tree, axml_bytes, ANDROID_NS, _string_pool
import struct


def build(**kw):
    return axml_bytes(manifest_tree(**kw))


class ManifestTests(unittest.TestCase):
    def test_basic_fields_utf8(self):
        m = parse_manifest(build(package='com.demo.app', permissions=['android.permission.INTERNET', 'android.permission.CAMERA']))
        self.assertEqual(m['package'], 'com.demo.app')
        self.assertEqual(m['version_name'], '2.5')
        self.assertEqual(m['version_code'], '25')
        self.assertEqual(m['min_sdk'], '21')
        self.assertEqual(m['target_sdk'], '34')
        self.assertEqual(m['permissions_declared'], ['android.permission.INTERNET', 'android.permission.CAMERA'])

    def test_utf16_pool(self):
        data = axml_bytes(manifest_tree(package='com.utf16.app'), utf8=False)
        self.assertEqual(parse_manifest(data)['package'], 'com.utf16.app')

    def test_application_flags_and_components(self):
        data = build(application={'debuggable': True, 'allowBackup': False, 'usesCleartextTraffic': True},
                     components=[{'type': 'activity', 'name': '.MainActivity', 'exported': True},
                                 {'type': 'service', 'name': '.SyncService', 'exported': False, 'permission': 'com.demo.PERM'}])
        m = parse_manifest(data)
        self.assertEqual(m['application']['debuggable'], 'true')
        self.assertEqual(m['application']['allowBackup'], 'false')
        self.assertEqual(m['application']['usesCleartextTraffic'], 'true')
        self.assertEqual(len(m['components']), 2)
        self.assertEqual(m['components'][0]['exported'], 'true')
        self.assertEqual(m['components'][1]['permission'], 'com.demo.PERM')

    def test_deep_links(self):
        data = build(components=[{'type': 'activity', 'name': '.DeepLinkActivity', 'exported': True,
                                  'intent_filters': [{'actions': ['android.intent.action.VIEW'],
                                                      'categories': ['android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE'],
                                                      'data': [{'scheme': 'https', 'host': 'example.com'}, {'scheme': 'myapp'}]}]}])
        m = parse_manifest(data)
        self.assertEqual(len(m['deep_links']), 1)
        link = m['deep_links'][0]
        self.assertEqual(link['component'], '.DeepLinkActivity')
        self.assertEqual(link['schemes'], ['https', 'myapp'])
        self.assertEqual(link['hosts'], ['example.com'])

    def test_non_browsable_not_deep_link(self):
        data = build(components=[{'type': 'activity', 'name': '.Main',
                                  'intent_filters': [{'actions': ['android.intent.action.MAIN'],
                                                      'categories': ['android.intent.category.LAUNCHER']}]}])
        self.assertEqual(parse_manifest(data)['deep_links'], [])

    def test_plain_xml_rejected(self):
        with self.assertRaises(ValueError):
            parse_manifest(b'<?xml version="1.0"?><manifest package="x"></manifest>')

    def test_truncated_does_not_crash(self):
        data = build()
        for cut in (0, 4, 8, 20, len(data) // 2):
            try:
                parse_manifest(data[:cut])
            except ValueError:
                pass

    def test_string_pool_bounds(self):
        pool = _string_pool(['hola', 'mundo'], utf8=True)
        self.assertEqual(read_string_pool(pool), ['hola', 'mundo'])
        with self.assertRaises(ValueError):
            read_string_pool(pool[:10])


class ArscTests(unittest.TestCase):
    def test_global_string_pool(self):
        pool = _string_pool(['https://api.example.com/v1/catalog', 'app_name'], utf8=True)
        table = struct.pack('<HHII', 0x0002, 12, 12 + len(pool), 1) + pool
        strings = arsc_strings(table)
        self.assertIn('https://api.example.com/v1/catalog', strings)

    def test_not_a_table(self):
        with self.assertRaises(ValueError):
            arsc_strings(b'not an arsc file at all')


if __name__ == '__main__':
    unittest.main()
