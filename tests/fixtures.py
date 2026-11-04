"""Synthetic binary fixtures (AXML, DEX, DER) for offline tests. No third-party code."""
import struct

ANDROID_NS = 'http://schemas.android.com/apk/res/android'


def _enc_len8(n):
    return bytes([(n >> 8) | 0x80, n & 0xFF]) if n >= 0x80 else bytes([n])


def _string_pool(strings, utf8=True):
    entries, offsets = [], []
    pos = 0
    for s in strings:
        offsets.append(pos)
        if utf8:
            raw = s.encode('utf-8')
            entry = _enc_len8(len(s)) + _enc_len8(len(raw)) + raw + b'\x00'
        else:
            raw = s.encode('utf-16le')
            n = len(s)
            length = struct.pack('<H', n) if n < 0x8000 else struct.pack('<HH', (n >> 16) | 0x8000, n & 0xFFFF)
            entry = length + raw + b'\x00\x00'
        entries.append(entry)
        pos += len(entry)
    blob = b''.join(entries)
    pad = (-len(blob)) % 4
    blob += b'\x00' * pad
    strings_start = 28 + len(strings) * 4
    size = strings_start + len(blob)
    header = struct.pack('<HHIIIIII', 0x0001, 28, size, len(strings), 0, 0x100 if utf8 else 0, strings_start, 0)
    return header + b''.join(struct.pack('<I', o) for o in offsets) + blob


def axml_bytes(tree, utf8=True):
    """Build binary XML from {'tag', 'attrs': {(ns, name): value}, 'children': []}."""
    strings = []
    index = {}

    def sid(s):
        if s not in index:
            index[s] = len(strings)
            strings.append(s)
        return index[s]

    def collect(node):
        sid(node['tag'])
        for (ns, name), value in node.get('attrs', {}).items():
            if ns:
                sid(ns)
            sid(name)
            if isinstance(value, str):
                sid(value)
        if node.get('text'):
            sid(node['text'])
        for child in node.get('children', []):
            collect(child)

    collect(tree)
    pool = _string_pool(strings, utf8)

    def tag_chunk(kind, payload):
        # ResXMLTree_node: ResChunk_header (8) + lineNumber (4) + comment (4).
        return struct.pack('<HHIII', kind, 16, 16 + len(payload), 0, 0xFFFFFFFF) + payload

    out = []

    def emit(node):
        attrs = node.get('attrs', {})
        attr_start, attr_size, count = 20, 20, len(attrs)
        head = struct.pack('<IIHHHHHH', 0xFFFFFFFF, sid(node['tag']), attr_start, attr_size, count, 0, 0, 0)
        body = b''
        for (ns, name), value in attrs.items():
            ans = sid(ns) if ns else 0xFFFFFFFF
            aname = sid(name)
            if isinstance(value, bool):
                raw, dtype, data = 0xFFFFFFFF, 0x12, 0xFFFFFFFF if value else 0
            elif isinstance(value, int):
                raw, dtype, data = 0xFFFFFFFF, 0x10, value & 0xFFFFFFFF
            else:
                raw, dtype, data = sid(value), 0x03, sid(value)
            body += struct.pack('<IIIHBBI', ans, aname, raw, 8, 0, dtype, data)
        out.append(tag_chunk(0x0102, head + body))
        if node.get('text'):
            tidx = sid(node['text'])
            out.append(struct.pack('<HHIII', 0x0104, 16, 28, 0, 0xFFFFFFFF) +
                       struct.pack('<I', tidx) + struct.pack('<HBBI', 8, 0, 0x03, tidx))
        for child in node.get('children', []):
            emit(child)
        out.append(tag_chunk(0x0103, struct.pack('<II', 0xFFFFFFFF, sid(node['tag']))))

    emit(tree)
    body = b''.join(out)
    header = struct.pack('<HHI', 0x0003, 8, 8 + len(pool) + len(body))
    return header + pool + body


def manifest_tree(package='com.example.test', permissions=(), application=None, components=(),
                  min_sdk='21', target_sdk='34', version_name='2.5', version_code='25'):
    def a(name):
        return (ANDROID_NS, name)

    children = []
    if min_sdk is not None or target_sdk is not None:
        attrs = {}
        if min_sdk is not None:
            attrs[a('minSdkVersion')] = min_sdk
        if target_sdk is not None:
            attrs[a('targetSdkVersion')] = target_sdk
        children.append({'tag': 'uses-sdk', 'attrs': attrs, 'children': []})
    for perm in permissions:
        children.append({'tag': 'uses-permission', 'attrs': {a('name'): perm}, 'children': []})
    app_children = []
    for comp in components:
        filters = []
        for f in comp.get('intent_filters', []):
            fchildren = []
            for action in f.get('actions', []):
                fchildren.append({'tag': 'action', 'attrs': {a('name'): action}, 'children': []})
            for cat in f.get('categories', []):
                fchildren.append({'tag': 'category', 'attrs': {a('name'): cat}, 'children': []})
            for data in f.get('data', []):
                dattrs = {a(k): v for k, v in data.items()}
                fchildren.append({'tag': 'data', 'attrs': dattrs, 'children': []})
            filters.append({'tag': 'intent-filter', 'attrs': {}, 'children': fchildren})
        cattrs = {a('name'): comp['name']}
        if 'exported' in comp:
            cattrs[a('exported')] = comp['exported']
        if 'permission' in comp:
            cattrs[a('permission')] = comp['permission']
        app_children.append({'tag': comp.get('type', 'activity'), 'attrs': cattrs, 'children': filters})
    app_attrs = {a(k): v for k, v in (application or {}).items()}
    children.append({'tag': 'application', 'attrs': app_attrs, 'children': app_children})
    root_attrs = {('', 'package'): package, a('versionName'): version_name, a('versionCode'): version_code}
    return {'tag': 'manifest', 'attrs': root_attrs, 'children': children}


def _uleb128(n):
    out = b''
    while True:
        byte = n & 0x7F
        n >>= 7
        if n:
            out += bytes([byte | 0x80])
        else:
            return out + bytes([byte])


def dex_bytes(strings, version=b'035'):
    ids_off = 112
    data_off = ids_off + len(strings) * 4
    ids, data = b'', b''
    pos = data_off
    for s in strings:
        ids += struct.pack('<I', pos)
        raw = s.encode('utf-8')
        item = _uleb128(len(s)) + raw + b'\x00'
        data += item
        pos += len(item)
    file_size = data_off + len(data)
    header = bytearray(112)
    header[0:8] = b'dex\n' + version + b'\x00'
    struct.pack_into('<I', header, 0x20, file_size)
    struct.pack_into('<I', header, 0x24, 0x70)
    struct.pack_into('<I', header, 0x28, 0x12345678)
    struct.pack_into('<I', header, 0x38, len(strings))
    struct.pack_into('<I', header, 0x3C, ids_off)
    return bytes(header) + ids + data


def _tlv(tag, value):
    if len(value) < 0x80:
        return bytes([tag, len(value)]) + value
    length = len(value)
    n = (length.bit_length() + 7) // 8
    return bytes([tag, 0x80 | n]) + length.to_bytes(n, 'big') + value


def _name(cn):
    oid = bytes([0x55, 0x04, 0x03])
    atv = _tlv(0x30, _tlv(0x06, oid) + _tlv(0x13, cn.encode()))
    return _tlv(0x30, _tlv(0x31, atv))


def der_cert(subject_cn='Example Signer', issuer_cn='Example CA', year=2030, generalized=False):
    version = _tlv(0xA0, _tlv(0x02, b'\x02'))
    serial = _tlv(0x02, b'\x12\x34')
    alg = _tlv(0x30, _tlv(0x06, bytes([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B])) + _tlv(0x05, b''))
    if generalized:
        before = _tlv(0x18, ('20180221122739Z').encode())
        after = _tlv(0x18, ('%d0128122739Z' % year).encode())
    else:
        before = _tlv(0x17, b'180221122739Z')
        after = _tlv(0x17, ('%02d0128122739Z' % (year % 100)).encode())
    validity = _tlv(0x30, before + after)
    spki = _tlv(0x30, _tlv(0x30, _tlv(0x06, bytes([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01])) + _tlv(0x05, b'')) + _tlv(0x03, b'\x00\x01\x02'))
    tbs = _tlv(0x30, version + serial + alg + _name(issuer_cn) + validity + _name(subject_cn) + spki)
    return _tlv(0x30, tbs + alg + _tlv(0x03, b'\x00' + b'\x99' * 8))


def pkcs7(cert_der):
    signed_data = _tlv(0x30, _tlv(0x02, b'\x01') + _tlv(0x31, b'') +
                       _tlv(0x30, _tlv(0x06, bytes([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x01]))) +
                       _tlv(0xA0, cert_der) + _tlv(0x31, b''))
    oid = bytes([0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02])
    return _tlv(0x30, _tlv(0x06, oid) + _tlv(0xA0, signed_data))


def signing_block(pair_ids):
    pairs = b''
    for pid in pair_ids:
        value = b'\x00' * 16
        pairs += struct.pack('<Q', 4 + len(value)) + struct.pack('<I', pid) + value
    size = len(pairs) + 24
    return struct.pack('<Q', size) + pairs + struct.pack('<Q', size) + b'APK Sig Block 42'
