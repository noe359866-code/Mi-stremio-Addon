"""Bounded, offline APK inspection. Never extracts or executes archive contents."""
import hashlib
import io
import re
import struct
import zipfile
from urllib.parse import urlsplit
from reporting import enrich
from axml import parse_manifest, arsc_strings
from dex import dex_info, DEX_NAME
from certs import cert_info, signing_schemes, JAR_CERT, JAR_SF, MAX_CERT_BYTES

MAX_UPLOAD = 80 * 1024 * 1024
MAX_EXPANDED = 240 * 1024 * 1024
MAX_ENTRY = 32 * 1024 * 1024
URL = re.compile(r'https?://[^\s<>"\x00-\x20\x7f\\\]\[{}|^`]{4,500}|wss?://[^\s<>"\x00-\x20\x7f\\\]\[{}|^`]{4,500}', re.I)
PERMISSION = re.compile(r'android\.permission\.[A-Z][A-Z_0-9]+')
SECRET = re.compile(r'(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|authorization|password)\s*["\x27]?\s*[:=]\s*["\x27]?([a-zA-Z0-9_./+\-=]{12,160})')
# High-signal public token formats (inspired by the pattern coverage of APKLeaks,
# reimplemented here). Values are always redacted; matches are heuristic.
TOKEN_PATTERNS = [
    ('Clave API de Google', re.compile(r'AIza[0-9A-Za-z_\-]{35}')),
    ('ID de clave AWS', re.compile(r'(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}')),
    ('Token de GitHub', re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}')),
    ('Token de Slack', re.compile(r'xox[baprs]-[A-Za-z0-9-]{10,}')),
    ('Clave de Stripe', re.compile(r'(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}')),
    ('Token de SendGrid', re.compile(r'SG\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}')),
    ('Clave de Mailgun', re.compile(r'key-[0-9a-zA-Z]{32}')),
    ('Token OAuth de Google', re.compile(r'ya29\.[A-Za-z0-9_\-]{20,}')),
    ('JWT', re.compile(r'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}')),
    ('Clave privada', re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----')),
    ('Clave de Twilio', re.compile(r'SK[0-9a-fA-F]{32}')),
]


def axml_strings(data):
    """Read Android's binary XML string pool, including UTF-8 and UTF-16."""
    found = []
    offset = 8
    while offset + 8 <= len(data):
        kind, header, size = struct.unpack_from('<HHI', data, offset)
        if size < 8 or offset + size > len(data):
            break
        if kind == 1 and header >= 28:
            count, _, flags, start, _ = struct.unpack_from('<IIIII', data, offset + 8)
            if count > 100000 or header + count * 4 > size:
                break
            for i in range(count):
                p = offset + start + struct.unpack_from('<I', data, offset + header + i * 4)[0]
                end = offset + size
                try:
                    if flags & 0x100:
                        def length(pos):
                            n = data[pos]
                            return (((n & 127) << 8) | data[pos + 1], pos + 2) if n & 128 else (n, pos + 1)
                        _, p = length(p)
                        n, p = length(p)
                        if p + n <= end:
                            found.append(data[p:p+n].decode('utf-8', 'replace'))
                    else:
                        n = struct.unpack_from('<H', data, p)[0]
                        p += 2
                        if n & 0x8000:
                            n = ((n & 0x7fff) << 16) | struct.unpack_from('<H', data, p)[0]
                            p += 2
                        if p + n * 2 <= end:
                            found.append(data[p:p+n*2].decode('utf-16le', 'replace'))
                except (IndexError, struct.error):
                    continue
        offset += size
    return found


def _raw_text(data):
    text = data.decode('utf-8', 'replace')
    # Recover printable UTF-16LE strings found in resources and native binaries.
    wide = re.findall(rb'(?:[\x20-\x7e]\x00){6,}', data)
    text += '\n' + '\n'.join(w.decode('utf-16le') for w in wide)
    return text.replace(r'\/', '/')


def _scan_secrets(text, filename, secrets):
    for match in SECRET.finditer(text):
        secrets.append({'type': match.group(1), 'value': '•••••••• (oculto)', 'file': filename})
        if len(secrets) >= 500:
            return
    for label, pattern in TOKEN_PATTERNS:
        for _match in pattern.finditer(text):
            secrets.append({'type': label, 'value': '•••••••• (oculto)', 'file': filename})
            if len(secrets) >= 500:
                return


def analyze(blob, filename):
    if len(blob) > MAX_UPLOAD:
        raise ValueError('El archivo supera el límite de 80 MB.')
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        raise ValueError('El archivo no es un APK/ZIP válido.')
    with archive:
        entries = archive.infolist()
        if len(entries) > 20000 or sum(e.file_size for e in entries) > MAX_EXPANDED:
            raise ValueError('El APK supera los límites de descompresión segura.')
        if 'AndroidManifest.xml' not in archive.namelist():
            raise ValueError('No se encontró AndroidManifest.xml. Selecciona un APK.')
        urls, permissions, secrets, warnings = {}, set(), [], []
        manifest, dex_files, certificates = None, [], []
        has_sf, has_jar_cert = False, False
        scanned = 0
        for entry in entries:
            if entry.is_dir():
                continue
            if entry.file_size > MAX_ENTRY or entry.flag_bits & 1:
                warnings.append('Archivo omitido por tamaño o cifrado: ' + entry.filename[:200])
                continue
            if len(urls) >= 3000 or len(secrets) >= 500:
                warnings.append('Se alcanzó el límite de hallazgos; el reporte es parcial.')
                break
            data = archive.read(entry)
            scanned += 1
            name = entry.filename
            if name == 'AndroidManifest.xml':
                try:
                    manifest = parse_manifest(data)
                except ValueError as exc:
                    warnings.append('Manifiesto no estructurado (escaneo de cadenas): ' + str(exc)[:120])
                text = _raw_text(data) + '\n' + '\n'.join(axml_strings(data))
            elif DEX_NAME.search(name):
                try:
                    strings, meta = dex_info(data)
                    dex_files.append(dict(meta, file=name))
                    text = '\n'.join(strings)
                except ValueError:
                    warnings.append('DEX no estructurado (escaneo crudo): ' + name[:200])
                    text = _raw_text(data)
            elif name == 'resources.arsc':
                try:
                    text = _raw_text(data) + '\n' + '\n'.join(arsc_strings(data))
                except ValueError:
                    text = _raw_text(data)
            else:
                text = _raw_text(data)
                if JAR_SF.match(name):
                    has_sf = True
                if JAR_CERT.match(name):
                    has_jar_cert = True
                    if len(data) <= MAX_CERT_BYTES and len(certificates) < 10:
                        try:
                            certificates.extend(cert_info(data))
                        except ValueError:
                            warnings.append('Bloque de firma no legible: ' + name[:200])
            for match in URL.finditer(text):
                raw = match.group().rstrip('.,;:)\'')
                try:
                    parsed = urlsplit(raw)
                    host = parsed.hostname
                    port = parsed.port
                    if not host:
                        continue
                except ValueError:
                    continue
                # Query values, fragments, userinfo and token-like path segments are not exported.
                path = re.sub(r'(?<=/)[A-Za-z0-9_=-]{32,}(?=/|$)', '[oculto]', parsed.path)
                authority = ('[' + host + ']' if ':' in host else host) + (':' + str(port) if port else '')
                safe = parsed.scheme.lower() + '://' + authority + path
                item = urls.setdefault(safe, {'url': safe, 'host': host, 'scheme': parsed.scheme.lower(), 'files': []})
                if entry.filename not in item['files'] and len(item['files']) < 5:
                    item['files'].append(entry.filename)
                if len(urls) >= 3000:
                    break
            permissions.update(PERMISSION.findall(text))
            _scan_secrets(text, name, secrets)
        schemes = signing_schemes(blob, archive.start_dir)
        signature = {'v1': has_sf and has_jar_cert, 'v2': schemes['v2'], 'v3': schemes['v3'],
                     'block_ids': schemes['block_ids'], 'certificates': certificates}
        return enrich({'filename': filename, 'sha256': hashlib.sha256(blob).hexdigest(), 'size': len(blob),
                'files_total': len(entries), 'files_scanned': scanned,
                'urls': sorted(urls.values(), key=lambda x: x['url']), 'permissions': sorted(permissions),
                'secrets': secrets, 'warnings': warnings,
                'manifest': manifest, 'dex': dex_files, 'signature': signature,
                'limitations': 'Análisis estático orientativo. No confirma que las URLs sean APIs activas ni detecta todo el contenido cifrado, ofuscado o generado en ejecución. Las coincidencias de secretos pueden ser falsos positivos. Se omiten valores de consultas, fragmentos y posibles tokens largos en rutas. La firma se identifica, no se verifica criptográficamente.'})
