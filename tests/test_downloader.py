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
