import unittest
from known_domains import classify


class KnownDomainTests(unittest.TestCase):
    def test_exact_and_subdomain(self):
        self.assertEqual(classify('firebaseio.com')['sdk'], 'Firebase Realtime Database')
        self.assertEqual(classify('my-app.firebaseio.com')['category'], 'Backend / BaaS')
        self.assertEqual(classify('graph.facebook.com')['sdk'], 'Facebook Graph API')
        self.assertEqual(classify('www.google-analytics.com')['category'], 'Analíticas')

    def test_case_and_trailing_dot(self):
        self.assertEqual(classify('APP-MEASUREMENT.COM.')['sdk'], 'Firebase Analytics')

    def test_unknown_and_empty(self):
        self.assertIsNone(classify('api.my-private-server.com'))
        self.assertIsNone(classify(''))
        self.assertIsNone(classify(None))

    def test_no_partial_suffix_match(self):
        # 'notfirebaseio.com' must not match 'firebaseio.com'
        self.assertIsNone(classify('notfirebaseio.com'))
        self.assertIsNone(classify('evilgoogle.com'))


if __name__ == '__main__':
    unittest.main()
