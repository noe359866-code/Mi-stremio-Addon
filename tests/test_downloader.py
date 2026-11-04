import io
import unittest
from unittest.mock import patch
from downloader import download, normalize_link, mediafire_target, validate_url, DownloadError


class Response(io.BytesIO):
    def __init__(self, body, url, kind):
        super().__init__(body)
        self.url = url
        self.headers = {'Content-Type': kind}
    def geturl(self):
        return self.url


class DownloaderTests(unittest.TestCase):
    def test_dropbox(self):
        self.assertEqual(normalize_link('https://www.dropbox.com/s/a/app.apk?dl=0&x=y'), 'https://www.dropbox.com/s/a/app.apk?x=y&dl=1')
        self.assertEqual(normalize_link('https://dropbox.com.evil.org/a'), 'https://dropbox.com.evil.org/a')

    def test_mediafire_html_entities(self):
        self.assertEqual(mediafire_target('<a id="downloadButton" href="https://download1.mediafire.com/a?x=1&amp;y=2">Download</a>', 'https://www.mediafire.com/file/a'), 'https://download1.mediafire.com/a?x=1&y=2')

    def test_mediafire_no_untrusted_target(self):
        for page in ('<a id="downloadButton" href="https://evil.org/a">x</a>', '<a id="downloadButton" href="javascript:alert(1)">x</a>', '<p>captcha</p>'):
            with self.assertRaises(DownloadError): mediafire_target(page, 'https://www.mediafire.com/file/a')

    def test_private_destinations_rejected(self):
        with patch('downloader.socket.getaddrinfo', return_value=[(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaises(DownloadError): validate_url('https://internal.example/a')
        with self.assertRaises(DownloadError): validate_url('http://example.org/a')

    @patch('downloader.validate_url')
    @patch('downloader.build_opener')
    def test_mediafire_download(self, opener, validate):
        opener.return_value.open.side_effect = [Response(b'<a id="downloadButton" href="https://download1.mediafire.com/app.apk">x</a>', 'https://www.mediafire.com/file/a', 'text/html'), Response(b'PK\x03\x04test', 'https://download1.mediafire.com/app.apk', 'application/octet-stream')]
        self.assertEqual(download('https://www.mediafire.com/file/a'), b'PK\x03\x04test')
        self.assertGreaterEqual(validate.call_count, 4)

    @patch('downloader.validate_url')
    @patch('downloader.build_opener')
    def test_generic_html_rejected(self, opener, validate):
        opener.return_value.open.return_value = Response(b'<html>Login</html>', 'https://example.org/a', 'text/html')
        with self.assertRaises(DownloadError): download('https://example.org/a')

class DownloadHardeningTests(unittest.TestCase):
    def test_scrambled_mediafire(self):
        import base64
        target = 'https://download12.mediafire.com/a/app.apk'
        encoded = base64.b64encode(target.encode()).decode()
        self.assertEqual(mediafire_target('<a id="downloadButton" href="#" data-scrambled-url="'+encoded+'">x</a>', 'https://www.mediafire.com/file/a'), target)

    def test_literal_mediafire_redirect(self):
        page = "<script>window.location.href = 'https://download12.mediafire.com/a/app.apk';</script>"
        self.assertEqual(mediafire_target(page, 'https://www.mediafire.com/file/a'), 'https://download12.mediafire.com/a/app.apk')

    def test_invalid_or_spoofed_mediafire(self):
        pages = ['<a id="downloadButton" data-scrambled-url="%%%">x</a>',
                 '<a id="downloadButton" href="https://download.evil.mediafire.com/a">x</a>',
                 '<a id="downloadButton" href="https://download1.mediafire.com@evil.org/a">x</a>']
        for page in pages:
            with self.assertRaises(DownloadError): mediafire_target(page, 'https://www.mediafire.com/file/a')

    @patch('downloader.validate_url')
    @patch('downloader.build_opener')
    def test_http_error_hides_url(self, opener, validate):
        from urllib.error import HTTPError
        opener.return_value.open.side_effect = HTTPError('https://example.org/private-token', 403, 'secret', {}, None)
        with self.assertRaises(DownloadError) as error: download('https://example.org/private-token')
        self.assertIn('403', str(error.exception))
        self.assertNotIn('private-token', str(error.exception))

    @patch('downloader.validate_url')
    @patch('downloader.build_opener')
    @patch('downloader.time.monotonic', side_effect=[0, 121])
    def test_deadline(self, clock, opener, validate):
        opener.return_value.open.return_value = Response(b'PK\x03\x04test', 'https://example.org/app.apk', 'application/octet-stream')
        with self.assertRaises(DownloadError) as error: download('https://example.org/app.apk')
        self.assertIn('120', str(error.exception))
