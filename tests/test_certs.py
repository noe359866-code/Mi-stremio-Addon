import hashlib
import struct
import unittest
import zipfile
import io
from certs import cert_info, signing_schemes, JAR_CERT, JAR_SF
from fixtures import der_cert, pkcs7, signing_block


class CertTests(unittest.TestCase):
    def test_subject_issuer_and_fingerprint(self):
        der = der_cert(subject_cn='Example Signer', issuer_cn='Example CA')
        info = cert_info(der)[0]
        self.assertEqual(info['subject'], 'CN=Example Signer')
        self.assertEqual(info['issuer'], 'CN=Example CA')
        self.assertEqual(info['sha256'], hashlib.sha256(der).hexdigest())
        self.assertFalse(info['self_signed'])
        self.assertFalse(info['debug_certificate'])
        self.assertEqual(info['valid_from'], '2018-02-21T12:27:39Z')

    def test_debug_certificate_detected(self):
        info = cert_info(der_cert(subject_cn='Android Debug', issuer_cn='Android Debug'))[0]
        self.assertTrue(info['debug_certificate'])
        self.assertTrue(info['self_signed'])

    def test_generalized_time(self):
        info = cert_info(der_cert(year=2118, generalized=True))[0]
        self.assertEqual(info['valid_until'], '2118-01-28T12:27:39Z')

    def test_pkcs7_wrapper(self):
        der = der_cert(subject_cn='Wrapped Signer')
        info = cert_info(pkcs7(der))[0]
        self.assertEqual(info['subject'], 'CN=Wrapped Signer')
        self.assertEqual(info['sha256'], hashlib.sha256(der).hexdigest())

    def test_garbage_rejected(self):
        with self.assertRaises(ValueError):
            cert_info(b'this is not DER at all')

    def test_truncated_der(self):
        der = der_cert()
        with self.assertRaises(ValueError):
            cert_info(der[:12])

    def test_jar_name_patterns(self):
        self.assertTrue(JAR_CERT.match('META-INF/CERT.RSA'))
        self.assertTrue(JAR_CERT.match('META-INF/KEY.EC'))
        self.assertFalse(JAR_CERT.match('META-INF/CERT.SF'))
        self.assertTrue(JAR_SF.match('META-INF/CERT.SF'))
        self.assertFalse(JAR_SF.match('assets/CERT.RSA'))


class SigningBlockTests(unittest.TestCase):
    def _apk_with_block(self, pair_ids):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('AndroidManifest.xml', 'x')
        blob = out.getvalue()
        # Insert the signing block right before the central directory.
        cd = zipfile.ZipFile(io.BytesIO(blob)).start_dir
        block = signing_block(pair_ids)
        return blob[:cd] + block + blob[cd:], cd + len(block)

    def test_v2_and_v3_detected(self):
        blob, cd = self._apk_with_block([0x7109871A, 0xF05368C0])
        result = signing_schemes(blob, cd)
        self.assertTrue(result['v2'])
        self.assertTrue(result['v3'])
        self.assertEqual(result['block_ids'], ['0x7109871a', '0xf05368c0'])

    def test_no_block(self):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('AndroidManifest.xml', 'x')
        blob = out.getvalue()
        cd = zipfile.ZipFile(io.BytesIO(blob)).start_dir
        result = signing_schemes(blob, cd)
        self.assertFalse(result['v2'])
        self.assertFalse(result['v3'])

    def test_unknown_id_only(self):
        blob, cd = self._apk_with_block([0x42726577])
        result = signing_schemes(blob, cd)
        self.assertFalse(result['v2'])
        self.assertEqual(result['block_ids'], ['0x42726577'])


if __name__ == '__main__':
    unittest.main()
