import unittest
from api_candidates import recommend_apis


def url(s):
    return {'url': s, 'files': ['classes.dex']}


class CandidatesTests(unittest.TestCase):
    def test_ranking_and_evidence(self):
        found = recommend_apis([url('https://example.org/data.json'), url('https://api.example.org/api/v2/movies')])
        self.assertEqual(found[0]['confidence'], 'Alta')
        self.assertEqual(found[0]['files'], ['classes.dex'])
        self.assertEqual(found[0]['http_method'], 'Desconocido')
        self.assertEqual(found[1]['confidence'], 'Baja')
        self.assertTrue(found[0]['reasons'])

    def test_no_invented_paths_or_resources(self):
        self.assertEqual(recommend_apis([url('https://example.org/'), url('https://example.org/api/image.png'), url('wss://api.example.org/ws')]), [])

    def test_auth_and_cleartext_warning(self):
        candidate = recommend_apis([url('http://example.org/oauth/token')])[0]
        self.assertEqual(candidate['status'], 'No verificada')
        self.assertTrue(any('tokens' in a for a in candidate['recommendations']))
        self.assertTrue(any('TLS' in a for a in candidate['recommendations']))

    def test_path_boundaries(self):
        self.assertEqual(recommend_apis([url('https://example.org/capital')]), [])
