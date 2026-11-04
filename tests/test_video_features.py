import io
import unittest
import zipfile
from api_candidates import recommend_apis
from axml import parse_network_security
from analyzer import analyze
from fixtures import axml_bytes, manifest_tree


def nsc_tree():
    return {'tag': 'network-security-config', 'attrs': {}, 'children': [
        {'tag': 'base-config', 'attrs': {('', 'cleartextTrafficPermitted'): 'true'}, 'children': []},
        {'tag': 'domain-config', 'attrs': {('', 'cleartextTrafficPermitted'): 'true'}, 'children': [
            {'tag': 'domain', 'attrs': {('', 'includeSubdomains'): 'true'}, 'children': [], 'text': 'video.example.com'},
            {'tag': 'pin-set', 'attrs': {}, 'children': [
                {'tag': 'pin', 'attrs': {('', 'digest'): 'SHA-256'}, 'children': [], 'text': 'abc='},
            ]},
        ]},
    ]}


class VideoCandidateTests(unittest.TestCase):
    def test_hls_promoted_to_video(self):
        urls = [{'url': 'https://cdn.example.com/live/playlist.m3u8', 'host': 'cdn.example.com',
                 'scheme': 'https', 'files': ['classes.dex'], 'category': 'Vídeo/Streaming'}]
        cands = recommend_apis(urls)
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]['kind'], 'Vídeo/Streaming')
        self.assertGreaterEqual(cands[0]['score'], 6)

    def test_xtream_route(self):
        urls = [{'url': 'http://tv.example.com:25461/player_api.php', 'host': 'tv.example.com',
                 'scheme': 'http', 'files': ['classes.dex'], 'category': 'Otra URL'}]
        cands = recommend_apis(urls)
        self.assertEqual(len(cands), 1)
        self.assertTrue(any('Xtream' in r for r in cands[0]['reasons']))

    def test_data_api_kind(self):
        urls = [{'url': 'https://api.example.com/v1/users', 'host': 'api.example.com',
                 'scheme': 'https', 'files': ['classes.dex'], 'category': 'Posible API'}]
        self.assertEqual(recommend_apis(urls)[0]['kind'], 'Catálogo/Datos')

    def test_static_resource_still_excluded(self):
        urls = [{'url': 'https://example.com/logo.png', 'host': 'example.com',
                 'scheme': 'https', 'files': ['res/'], 'category': 'Recurso'}]
        self.assertEqual(recommend_apis(urls), [])


class NetworkSecurityTests(unittest.TestCase):
    def test_parse_nsc(self):
        info = parse_network_security(axml_bytes(nsc_tree()))
        self.assertTrue(info['base_cleartext'])
        self.assertEqual(info['cleartext_domains'], ['video.example.com'])
        self.assertEqual(info['pins'], 1)

    def test_not_nsc_rejected(self):
        with self.assertRaises(ValueError):
            parse_network_security(axml_bytes(manifest_tree()))

    def test_analyzer_integration_and_implicit_export(self):
        manifest = axml_bytes(manifest_tree(
            target_sdk='27',
            components=[{'type': 'activity', 'name': '.MainActivity',
                         'intent_filters': [{'actions': ['android.intent.action.MAIN'],
                                             'categories': ['android.intent.category.LAUNCHER']}]}]))
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('AndroidManifest.xml', manifest)
            z.writestr('res/xml/network_security_config.xml', axml_bytes(nsc_tree()))
        result = analyze(out.getvalue(), 'video.apk')
        self.assertIsNotNone(result['network_security'])
        self.assertEqual(result['network_security']['cleartext_domains'], ['video.example.com'])
        types = [f['type'] for f in result['findings']]
        self.assertIn('network_security_config permite HTTP', types)
        self.assertIn('Exportación implícita (Android < 12)', types)


if __name__ == '__main__':
    unittest.main()
