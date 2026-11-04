import io
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from api_probe import classify_body, probe, verify_candidates, validate_probe_url, ProbeError


class Response(io.BytesIO):
    def __init__(self, body, kind, status=200):
        super().__init__(body)
        self.headers = {'Content-Type': kind}
        self.status = status

    def getcode(self):
        return self.status


class ClassifyTests(unittest.TestCase):
    def test_hls(self):
        kind, detail = classify_body('application/vnd.apple.mpegurl', b'#EXTM3U\n#EXTINF:10,\nseg1.ts\n#EXTINF:10,\nseg2.ts')
        self.assertEqual(kind, 'Playlist HLS')
        self.assertIn('2 segmentos', detail)

    def test_dash(self):
        kind, _ = classify_body('application/dash+xml', b'<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash"></MPD>')
        self.assertEqual(kind, 'Manifiesto DASH')

    def test_json_keys_only_no_values(self):
        kind, detail = classify_body('application/json', b'{"streams": [{"url": "https://secret.example/token/abc"}], "total": 5}')
        self.assertEqual(kind, 'JSON')
        self.assertIn('streams', detail)
        self.assertNotIn('secret.example', detail)
        self.assertNotIn('abc', detail)

    def test_json_list(self):
        kind, detail = classify_body('application/json', b'[{"a":1},{"a":2}]')
        self.assertEqual(kind, 'JSON')
        self.assertIn('2 elementos', detail)

    def test_html_and_xml(self):
        self.assertEqual(classify_body('text/html', b'<html><body>Login</body></html>')[0], 'HTML')
        self.assertEqual(classify_body('text/xml', b'<?xml version="1.0"?><tv></tv>')[0], 'XML')


class ProbeTests(unittest.TestCase):
    @patch('api_probe.validate_probe_url')
    @patch('api_probe.build_opener')
    def test_accessible_json(self, opener, validate):
        opener.return_value.open.return_value = Response(b'{"data": []}', 'application/json')
        r = probe('https://api.example.com/v1/catalog')
        self.assertEqual(r['status'], 'Accesible')
        self.assertEqual(r['http_status'], 200)
        self.assertEqual(r['kind'], 'JSON')
        self.assertTrue(r['tls'])

    @patch('api_probe.validate_probe_url')
    @patch('api_probe.build_opener')
    def test_hls_video(self, opener, validate):
        opener.return_value.open.return_value = Response(b'#EXTM3U\n#EXTINF:5,\na.ts', 'application/vnd.apple.mpegurl')
        r = probe('https://cdn.example.com/live/playlist.m3u8')
        self.assertEqual(r['kind'], 'Playlist HLS')
        self.assertEqual(r['status'], 'Accesible')

    @patch('api_probe.validate_probe_url')
    @patch('api_probe.build_opener')
    def test_http_error(self, opener, validate):
        opener.return_value.open.side_effect = HTTPError('https://api.example.com/x', 403, 'forbidden', {}, None)
        r = probe('https://api.example.com/x')
        self.assertEqual(r['status'], 'Error HTTP')
        self.assertEqual(r['http_status'], 403)
        self.assertIn('denegado', r['detail'])

    def test_private_ip_blocked(self):
        with patch('api_probe.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]):
            r = probe('https://internal.example/api')
        self.assertEqual(r['status'], 'Bloqueada')

    def test_redacted_path_not_probed(self):
        r = probe('https://api.example.com/[oculto]/catalog')
        self.assertEqual(r['status'], 'No verificable')

    def test_validate_rejects_userinfo_and_scheme(self):
        with self.assertRaises(ProbeError):
            validate_probe_url('https://user:pass@example.com/api')
        with self.assertRaises(ProbeError):
            validate_probe_url('ftp://example.com/api')

    @patch('api_probe.probe')
    def test_verify_bounds_and_summary(self, mock_probe):
        mock_probe.side_effect = lambda u: {'url': u, 'status': 'Accesible', 'kind': 'JSON', 'http_status': 200}
        urls = ['https://a.example/api'] * 100
        out = verify_candidates(urls)
        self.assertLessEqual(out['summary']['probed'], 40)
        self.assertEqual(out['summary']['accessible'], out['summary']['probed'])
        self.assertIn('no concede permiso', out['summary']['note'])


if __name__ == '__main__':
    unittest.main()
