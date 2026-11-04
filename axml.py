"""Bounded Android binary XML (AXML) and resource string-pool parsing.

Offline and defensive: never executes anything, caps every loop, and raises
ValueError on structurally invalid input so callers can fall back to raw
string scanning. Format references: androidfw ResourceTypes.h, and the
independent pure-Python parsers androguard/axml and bunseokbot/dexparser.
"""
import struct

ANDROID_NS = 'http://schemas.android.com/apk/res/android'
CHUNK_STRING_POOL = 0x0001
CHUNK_XML = 0x0003
CHUNK_XML_START_TAG = 0x0102
CHUNK_XML_END_TAG = 0x0103
CHUNK_XML_RESOURCE_MAP = 0x0180
MAX_STRINGS = 100000
MAX_STRING_BYTES = 65536
MAX_TAGS = 20000
MAX_ATTRS = 1024
NONE32 = 0xFFFFFFFF


def _len8(data, pos):
    n = data[pos]
    if n & 0x80:
        return ((n & 0x7F) << 8) | data[pos + 1], pos + 2
    return n, pos + 1


def _decode_string(data, pos, end, utf8):
    """Decode one ResStringPool entry; returns None when out of bounds."""
    if utf8:
        _, pos = _len8(data, pos)          # character count (unused)
        size, pos = _len8(data, pos)       # byte count
        if size > MAX_STRING_BYTES or pos + size > end:
            return None
        return data[pos:pos + size].decode('utf-8', 'replace')
    n = struct.unpack_from('<H', data, pos)[0]
    pos += 2
    if n & 0x8000:
        n = ((n & 0x7FFF) << 16) | struct.unpack_from('<H', data, pos)[0]
        pos += 2
    if n * 2 > MAX_STRING_BYTES or pos + n * 2 > end:
        return None
    return data[pos:pos + n * 2].decode('utf-16le', 'replace')


def read_string_pool(data, offset=0):
    """Read a ResStringPool chunk (used by AXML and resources.arsc)."""
    kind, header_size, size = struct.unpack_from('<HHI', data, offset)
    if kind != CHUNK_STRING_POOL or header_size < 28 or size < header_size:
        raise ValueError('Cabecera de string pool no válida.')
    end = offset + size
    if end > len(data):
        raise ValueError('String pool truncado.')
    count, _styles, flags, strings_start, _styles_start = struct.unpack_from('<IIIII', data, offset + 8)
    if count > MAX_STRINGS:
        raise ValueError('String pool demasiado grande.')
    if offset + header_size + count * 4 > end:
        raise ValueError('Tabla de offsets fuera del string pool.')
    utf8 = bool(flags & 0x100)
    base = offset + strings_start
    if base < offset + header_size + count * 4 or base > end:
        raise ValueError('Inicio de cadenas fuera del string pool.')
    strings = []
    for i in range(count):
        rel = struct.unpack_from('<I', data, offset + header_size + i * 4)[0]
        pos = base + rel
        if pos >= end:
            strings.append('')
            continue
        try:
            value = _decode_string(data, pos, end, utf8)
        except (IndexError, struct.error):
            value = None
        strings.append(value if value is not None else '')
    return strings


def _pool_size(data, offset):
    kind, _header, size = struct.unpack_from('<HHI', data, offset)
    if kind != CHUNK_STRING_POOL:
        raise ValueError('Se esperaba un string pool.')
    return size


def _attr_value(pool, raw, dtype, data):
    if dtype == 0x03:                                  # STRING
        return pool[data] if data < len(pool) else ''
    if dtype == 0x12:                                  # BOOLEAN
        return 'true' if data else 'false'
    if dtype == 0x10:                                  # INT_DEC (signed)
        return str(data - 0x100000000 if data >= 0x80000000 else data)
    if dtype == 0x11:                                  # INT_HEX
        return '0x%08x' % data
    if dtype == 0x01:                                  # REFERENCE
        return '@0x%08x' % data
    if raw != NONE32 and raw < len(pool):
        return pool[raw]
    return '0x%08x' % data


def parse_axml(data):
    """Parse binary XML into a tree of {'tag', 'attrs', 'children'}.

    Attribute keys are (namespace_uri, name); '' namespace for unqualified
    attributes such as manifest/@package.
    """
    if len(data) < 16:
        raise ValueError('AXML demasiado corto.')
    kind, header_size, _size = struct.unpack_from('<HHI', data, 0)
    if kind != CHUNK_XML or header_size != 8:
        raise ValueError('El archivo no es XML binario de Android.')
    pool = read_string_pool(data, 8)
    pos = 8 + _pool_size(data, 8)
    root, stack, tags = None, [], 0
    while pos + 8 <= len(data):
        kind, _header, size = struct.unpack_from('<HHI', data, pos)
        if size < 8 or pos + size > len(data):
            break
        if kind == CHUNK_XML_START_TAG:
            tags += 1
            if tags > MAX_TAGS:
                raise ValueError('Demasiadas etiquetas XML.')
            if pos + 36 > len(data):
                break
            _ns, name_idx = struct.unpack_from('<II', data, pos + 16)
            attr_start, attr_size, attr_count = struct.unpack_from('<HHH', data, pos + 24)
            if attr_size < 20:
                attr_size = 20
            attrs = {}
            base = pos + 16 + attr_start
            for i in range(min(attr_count, MAX_ATTRS)):
                a = base + i * attr_size
                if a + 20 > pos + size:
                    break
                ans, aname, araw = struct.unpack_from('<III', data, a)
                _vsize, _res0, vtype, vdata = struct.unpack_from('<HBBI', data, a + 12)
                uri = pool[ans] if ans != NONE32 and ans < len(pool) else ''
                name = pool[aname] if aname < len(pool) else ''
                if name:
                    attrs[(uri, name)] = _attr_value(pool, araw, vtype, vdata)
            node = {'tag': pool[name_idx] if name_idx < len(pool) else '', 'attrs': attrs, 'children': []}
            if stack:
                stack[-1]['children'].append(node)
            elif root is None:
                root = node
            stack.append(node)
        elif kind == CHUNK_XML_END_TAG:
            if stack:
                stack.pop()
        # Namespace, CDATA and resource-map chunks carry no manifest semantics.
        pos += size
    if root is None:
        raise ValueError('No se encontró la etiqueta raíz del XML binario.')
    return root


def _android(node, name):
    return node['attrs'].get((ANDROID_NS, name))


def _intent_filter(node):
    actions, categories, data = [], [], []
    for child in node['children']:
        if child['tag'] == 'action':
            value = _android(child, 'name')
            if value:
                actions.append(value)
        elif child['tag'] == 'category':
            value = _android(child, 'name')
            if value:
                categories.append(value)
        elif child['tag'] == 'data':
            entry = {k: _android(child, k) for k in ('scheme', 'host', 'port', 'path', 'pathPrefix', 'pathPattern', 'mimeType')}
            data.append({k: v for k, v in entry.items() if v})
    return {'actions': actions, 'categories': categories, 'data': data}


COMPONENT_TAGS = ('activity', 'activity-alias', 'service', 'receiver', 'provider')
APP_FLAGS = ('debuggable', 'allowBackup', 'usesCleartextTraffic', 'networkSecurityConfig',
             'extractNativeLibs', 'requestLegacyExternalStorage', 'appComponentFactory', 'name')


def parse_manifest(data):
    """Extract structured manifest facts: package, SDK, permissions, components."""
    root = parse_axml(data)
    if root['tag'] != 'manifest':
        raise ValueError('La raíz del XML binario no es <manifest>.')
    info = {
        'package': root['attrs'].get(('', 'package'), ''),
        'version_name': _android(root, 'versionName') or '',
        'version_code': _android(root, 'versionCode') or '',
        'min_sdk': None, 'target_sdk': None,
        'permissions_declared': [], 'permissions_defined': [], 'features': [],
        'application': {}, 'components': [], 'deep_links': [], 'queries_packages': [],
    }
    for child in root['children']:
        tag = child['tag']
        if tag == 'uses-sdk':
            info['min_sdk'] = _android(child, 'minSdkVersion')
            info['target_sdk'] = _android(child, 'targetSdkVersion')
        elif tag in ('uses-permission', 'uses-permission-sdk-23'):
            name = _android(child, 'name')
            if name and name not in info['permissions_declared']:
                info['permissions_declared'].append(name)
        elif tag == 'permission':
            name = _android(child, 'name')
            if name:
                info['permissions_defined'].append({'name': name, 'protection_level': _android(child, 'protectionLevel') or 'normal'})
        elif tag == 'uses-feature':
            name = _android(child, 'name')
            if name:
                info['features'].append({'name': name, 'required': _android(child, 'required') or 'true'})
        elif tag == 'queries':
            for q in child['children']:
                if q['tag'] == 'package':
                    name = _android(q, 'name')
                    if name:
                        info['queries_packages'].append(name)
        elif tag == 'application':
            info['application'] = {k: _android(child, k) for k in APP_FLAGS if _android(child, k) is not None}
            for comp in child['children']:
                if comp['tag'] not in COMPONENT_TAGS:
                    continue
                filters = [_intent_filter(f) for f in comp['children'] if f['tag'] == 'intent-filter']
                entry = {
                    'type': comp['tag'], 'name': _android(comp, 'name') or '',
                    'exported': _android(comp, 'exported'),
                    'permission': _android(comp, 'permission'),
                    'enabled': _android(comp, 'enabled'),
                    'intent_filters': filters,
                }
                if comp['tag'] == 'provider':
                    entry['authorities'] = _android(comp, 'authorities')
                    entry['grant_uri_permissions'] = _android(comp, 'grantUriPermissions')
                info['components'].append(entry)
                for f in filters:
                    if 'android.intent.category.BROWSABLE' in f['categories'] and any('scheme' in d for d in f['data']):
                        info['deep_links'].append({
                            'component': entry['name'],
                            'schemes': sorted({d['scheme'] for d in f['data'] if 'scheme' in d}),
                            'hosts': sorted({d['host'] for d in f['data'] if 'host' in d}),
                            'actions': f['actions'],
                        })
    return info


def arsc_strings(data):
    """Read the global string pool of a resources.arsc table."""
    if len(data) < 12:
        raise ValueError('resources.arsc demasiado corto.')
    kind, header_size, _size = struct.unpack_from('<HHI', data, 0)
    if kind != 0x0002:                                 # RES_TABLE_TYPE
        raise ValueError('El archivo no es una tabla de recursos.')
    return read_string_pool(data, header_size)
