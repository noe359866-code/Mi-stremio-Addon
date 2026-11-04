"""Minimal DER/X.509 inspection of APK signature material. Offline.

Parses just enough of the JAR signature block (PKCS#7 SignedData) to report
certificate subject/issuer, validity and SHA-256 fingerprint, and detects the
APK Signing Block (v2/v3) magic. It does NOT verify signatures, chains or
trust: a fingerprint identifies a certificate, it does not authenticate it.
"""
import hashlib
import re

MAX_CERT_BYTES = 1024 * 1024
MAX_NODES = 20000
MAX_DEPTH = 24
SIGNING_MAGIC = b'APK Sig Block 42'
V2_ID = 0x7109871A
V3_ID = 0xF05368C0
OID_NAMES = {'2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU'}
JAR_CERT = re.compile(r'^META-INF/.*\.(RSA|DSA|EC)$', re.I)
JAR_SF = re.compile(r'^META-INF/.*\.SF$', re.I)


class _Node:
    __slots__ = ('tag', 'tlv_start', 'start', 'end', 'children')

    def __init__(self, tag, tlv_start, start, end):
        self.tag, self.tlv_start, self.start, self.end = tag, tlv_start, start, end
        self.children = []


def _tlv(data, pos):
    if pos + 2 > len(data):
        raise ValueError('DER truncado.')
    tag = data[pos]
    first = data[pos + 1]
    pos += 2
    if first & 0x80:
        n = first & 0x7F
        if n == 0 or n > 4 or pos + n > len(data):
            raise ValueError('Longitud DER no soportada.')
        length = int.from_bytes(data[pos:pos + n], 'big')
        pos += n
    else:
        length = first
    end = pos + length
    if end > len(data):
        raise ValueError('Longitud DER fuera del archivo.')
    return tag, pos, end


def _walk_children(data, pos, end, depth, budget):
    children = []
    while pos < end:
        tlv_start = pos
        tag, vstart, vend = _tlv(data, pos)
        budget[0] -= 1
        if budget[0] < 0:
            raise ValueError('DER demasiado complejo.')
        child = _Node(tag, tlv_start, vstart, vend)
        if tag in (0x30, 0x31, 0xA0, 0xA3) and depth < MAX_DEPTH:   # constructed
            child.children = _walk_children(data, vstart, vend, depth + 1, budget)
        children.append(child)
        pos = vend
    return children


def _parse_tree(data):
    tag, vstart, vend = _tlv(data, 0)
    root = _Node(tag, 0, vstart, vend)
    if tag in (0x30, 0x31):
        root.children = _walk_children(data, vstart, vend, 1, [MAX_NODES])
    return root


def _find_certificates(node, out):
    """A Certificate is SEQUENCE { tbsCertificate SEQUENCE, sigAlg SEQUENCE, BIT STRING }."""
    if node.tag == 0x30 and len(node.children) == 3:
        tbs, alg, bits = node.children
        if tbs.tag == 0x30 and alg.tag == 0x30 and bits.tag == 0x03 and len(tbs.children) >= 6:
            out.append(node)
            return
    for child in node.children:
        _find_certificates(child, out)


def _oid(data, node):
    raw = data[node.start:node.end]
    if not raw:
        return ''
    parts = [str(raw[0] // 40), str(raw[0] % 40)]
    value = 0
    for byte in raw[1:]:
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            parts.append(str(value))
            value = 0
    return '.'.join(parts)


def _name(data, node):
    """Render an X.501 Name as 'CN=..., O=..., C=...' (unknown OIDs kept)."""
    parts = []
    for rdn in node.children:                       # SET
        for atv in rdn.children:                    # SEQUENCE { OID, value }
            if len(atv.children) >= 2 and atv.children[0].tag == 0x06:
                oid = _oid(data, atv.children[0])
                value_node = atv.children[1]
                value = data[value_node.start:value_node.end].decode('utf-8', 'replace')
                parts.append(OID_NAMES.get(oid, oid) + '=' + value)
    return ', '.join(parts)


def _time(data, node):
    raw = data[node.start:node.end].decode('ascii', 'replace')
    digits = re.sub(r'\D', '', raw)
    if node.tag == 0x17 and len(digits) >= 12:      # UTCTime YYMMDDHHMMSSZ
        year = int(digits[:2])
        year += 1900 if year >= 50 else 2000
        rest = digits[2:]
    elif node.tag == 0x18 and len(digits) >= 12:    # GeneralizedTime YYYYMMDDHHMMSSZ
        year = int(digits[:4])
        rest = digits[4:]
    else:
        return raw
    return '%04d-%s-%sT%s:%s:%sZ' % (year, rest[0:2], rest[2:4], rest[4:6], rest[6:8], rest[8:10] or '00')


def _cert_details(data, node):
    fields = node.children[0].children
    if fields and fields[0].tag == 0xA0:            # [0] EXPLICIT version
        fields = fields[1:]
    serial = int.from_bytes(data[fields[0].start:fields[0].end], 'big') if fields else 0
    issuer = _name(data, fields[2]) if len(fields) > 2 else ''
    validity = fields[3].children if len(fields) > 3 else []
    subject = _name(data, fields[4]) if len(fields) > 4 else ''
    fingerprint = hashlib.sha256(data[node.tlv_start:node.end]).hexdigest()
    debug = 'android debug' in (subject + ' ' + issuer).lower()
    return {
        'subject': subject, 'issuer': issuer,
        'valid_from': _time(data, validity[0]) if len(validity) > 0 else '',
        'valid_until': _time(data, validity[1]) if len(validity) > 1 else '',
        'serial': format(serial, 'x'),
        'sha256': fingerprint,
        'self_signed': bool(subject) and subject == issuer,
        'debug_certificate': debug,
    }


def cert_info(blob):
    """Extract certificates from a DER blob (X.509 or PKCS#7). Bounded."""
    if len(blob) > MAX_CERT_BYTES:
        raise ValueError('Bloque de firma demasiado grande.')
    root = _parse_tree(blob)
    certs = []
    _find_certificates(root, certs)
    if not certs:
        raise ValueError('No se encontró un certificado X.509 en el bloque de firma.')
    return [_cert_details(blob, c) for c in certs[:10]]


def signing_schemes(blob, central_directory_offset):
    """Detect v2/v3 signing block IDs before the ZIP central directory."""
    result = {'v2': False, 'v3': False, 'block_ids': []}
    cd = central_directory_offset
    if cd < 24 or cd > len(blob) or blob[cd - 16:cd] != SIGNING_MAGIC:
        return result
    size = int.from_bytes(blob[cd - 24:cd - 16], 'little')
    if size < 24 or size > cd - 8:
        return result
    pos, end = cd - size, cd - 24
    while pos + 8 <= end:
        length = int.from_bytes(blob[pos:pos + 8], 'little')
        if length < 4 or pos + 8 + length > end:
            break
        pair_id = int.from_bytes(blob[pos + 8:pos + 12], 'little')
        result['block_ids'].append('0x%08x' % pair_id)
        if pair_id == V2_ID:
            result['v2'] = True
        elif pair_id == V3_ID:
            result['v3'] = True
        pos += 8 + length
    return result
