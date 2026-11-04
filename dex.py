"""Bounded DEX string-pool extraction. No disassembly, no execution.

Reads string_ids/string_data_item (ULEB128 length + MUTF-8 bytes) so URLs and
secrets are recovered as clean strings instead of raw byte regex matches.
Header layout per the public DEX format; cross-checked against the independent
pure-Python parser bunseokbot/dexparser.
"""
import re
import struct

MAX_STRINGS = 300000
MAX_STRING_BYTES = 65536
DEX_NAME = re.compile(r'(?:^|/)classes\d*\.dex$', re.I)


def is_dex(data):
    return len(data) >= 112 and data[:4] == b'dex\n'


def _uleb128(data, pos):
    value, shift = 0, 0
    for _ in range(5):
        if pos >= len(data):
            raise ValueError('ULEB128 truncado.')
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7
    raise ValueError('ULEB128 demasiado largo.')


def dex_info(data):
    """Return (strings, metadata). Raises ValueError on invalid structure."""
    if not is_dex(data):
        raise ValueError('El archivo no tiene cabecera DEX.')
    count, offset = struct.unpack_from('<II', data, 0x38)
    classes = struct.unpack_from('<I', data, 0x60)[0]
    if count > MAX_STRINGS:
        raise ValueError('El DEX declara demasiadas cadenas.')
    if offset + count * 4 > len(data):
        raise ValueError('Tabla string_ids fuera del DEX.')
    strings = []
    for i in range(count):
        pos = struct.unpack_from('<I', data, offset + i * 4)[0]
        if pos >= len(data):
            continue
        try:
            _length, pos = _uleb128(data, pos)
        except ValueError:
            continue
        end = data.find(b'\x00', pos, min(pos + MAX_STRING_BYTES + 1, len(data)))
        if end == -1:
            continue
        # MUTF-8 differs from UTF-8 only for NUL and supplementary characters;
        # replacement decoding is safe for URL/secret scanning.
        strings.append(data[pos:end].decode('utf-8', 'replace'))
    return strings, {
        'version': data[4:7].decode('ascii', 'replace'),
        'strings_declared': count,
        'strings_read': len(strings),
        'classes': classes,
    }
