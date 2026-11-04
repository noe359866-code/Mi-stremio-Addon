import unittest
from dex import dex_info, is_dex, DEX_NAME
from fixtures import dex_bytes


class DexTests(unittest.TestCase):
    def test_strings_and_metadata(self):
        strings = ['https://api.example.com/v1/catalog', 'Lcom/example/Main;', 'api_key="abcdefgh12345678"']
        data = dex_bytes(strings)
        out, meta = dex_info(data)
        self.assertEqual(out, strings)
        self.assertEqual(meta['strings_declared'], 3)
        self.assertEqual(meta['strings_read'], 3)
        self.assertEqual(meta['version'], '035')
        self.assertTrue(is_dex(data))

    def test_multibyte_uleb128(self):
        long_string = 'x' * 300
        out, _ = dex_info(dex_bytes([long_string, 'corto']))
        self.assertEqual(out[0], long_string)
        self.assertEqual(out[1], 'corto')

    def test_unicode_strings(self):
        out, _ = dex_info(dex_bytes(['https://ejemplo.com/cañón', '日本語']))
        self.assertIn('https://ejemplo.com/cañón', out)

    def test_not_dex(self):
        self.assertFalse(is_dex(b'plain text, not a dex'))
        with self.assertRaises(ValueError):
            dex_info(b'plain text, not a dex')

    def test_truncated_header(self):
        with self.assertRaises(ValueError):
            dex_info(b'dex\n035\x00' + b'\x00' * 20)

    def test_corrupt_offset_skipped(self):
        data = bytearray(dex_bytes(['https://ok.example/api']))
        # Point the first string id far beyond the file; parser must skip, not crash.
        import struct
        struct.pack_into('<I', data, 112, 0xFFFFFF)
        out, meta = dex_info(bytes(data))
        self.assertEqual(out, [])
        self.assertEqual(meta['strings_read'], 0)

    def test_dex_name_matching(self):
        for name in ('classes.dex', 'classes2.dex', 'classes10.dex', 'assets/classes3.dex'):
            self.assertTrue(DEX_NAME.search(name), name)
        for name in ('classes.dex.bak', 'notclasses.dex', 'resources.arsc'):
            self.assertFalse(DEX_NAME.search(name), name)


if __name__ == '__main__':
    unittest.main()
