import unittest
from unittest.mock import patch
from downloader import downloader_url, aftv_target, normalize_link, download, DownloadError
from test_downloader import Response


class AFTVTests(unittest.TestCase):
    def test_code_validation(self):
        self.assertEqual(downloader_url(' 5842501 '), 'https://go.aftvnews.com/5842501')
        for code in ('', 'x', '../test', '12345678901', '1; echo bad'):
            with self.assertRaises(DownloadError): downloader_url(code)

    def test_refresh_and_link(self):
        base = 'https://go.aftvnews.com/5842501'
        target = 'https://www.mediafire.com/file/sample'
        self.assertEqual(aftv_target('<meta http-equiv="refresh" content="5; URL='+target+'">', base), target)
        self.assertEqual(aftv_target('<a id="redirect-link" href="'+target+'">here</a>', base), target)
        self.assertEqual(normalize_link('http://go.aftvnews.com/5842501'), base)

    def test_reject_ambiguous_and_script(self):
        for page in ('<script>window.location="https://example.org"</script>', '<a id="redirect-link" href="javascript:alert(1)">x</a>', '<meta http-equiv="refresh" content="0;url=https://one.example"><a id="redirect-link" href="https://two.example">x</a>'):
            with self.assertRaises(DownloadError): aftv_target(page, 'https://go.aftvnews.com/1')

    @patch('downloader.validate_url')
    @patch('downloader.build_opener')
    def test_code_to_mediafire_to_apk(self, opener, validate):
        opener.return_value.open.side_effect = [
            Response(b'<meta http-equiv="refresh" content="5; url=https://www.mediafire.com/file/test">', 'https://go.aftvnews.com/5842501', 'text/html'),
            Response(b'<a id="downloadButton" href="https://download1.mediafire.com/app.apk">x</a>', 'https://www.mediafire.com/file/test', 'text/html'),
            Response(b'PK\x03\x04test', 'https://download1.mediafire.com/app.apk', 'application/octet-stream')]
        self.assertEqual(download(downloader_url('5842501')), b'PK\x03\x04test')
        self.assertEqual(opener.return_value.open.call_count, 3)

    @patch('downloader.validate_url')
    @patch('downloader.build_opener')
    def test_loop_rejected(self, opener, validate):
        opener.return_value.open.return_value = Response(b'<meta http-equiv="refresh" content="0; url=https://go.aftvnews.com/1">', 'https://go.aftvnews.com/1', 'text/html')
        with self.assertRaises(DownloadError): download('https://go.aftvnews.com/1')
