"""Opt-in, bounded reachability checks for candidate APIs.

This is the ONLY part of APK Lens that touches the network beyond downloading
the APK itself, and it never runs unless explicitly requested (web button or
CLI --verify). Safety rules:
  * Never sends credentials, tokens, cookies or headers found in the APK.
  * Blocks private/reserved destinations (basic SSRF guard) and URL userinfo.
  * Bounded: max candidates, per-request timeout, total budget, response size.
  * Returns a redacted classification, never the full response body.
Reachability is NOT authorization: a 200 does not grant permission to use an API.
DNS-rebinding caveat applies as in downloader.py; use egress control if exposed.
"""
import ipaddress
import json
import socket
import time
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.error import HTTPError, URLError

MAX_PROBES = 40
MAX_BODY = 256 * 1024
PER_TIMEOUT = 8
TOTAL_BUDGET = 90
UA = 'APK-Lens-Verify/1.0'


class ProbeError(ValueError):
    pass


def validate_probe_url(url):
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        raise ProbeError('URL no verificable: esquema/host no válido o credenciales en la URL.')
    port = p.port or (443 if p.scheme == 'https' else 80)
    try:
        addresses = socket.getaddrinfo(p.hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        raise ProbeError('No se pudo resolver el host.')
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ProbeError('Destino interno o privado: no se verifica (protección SSRF).')


class _ProbeRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_probe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def classify_body(content_type, body):
    """Return (kind, detail) from a bounded response sample. No values leaked."""
    ct = (content_type or '').lower()
    head = body[:4096]
    stripped = head.lstrip()
    if b'#EXTM3U' in head or 'mpegurl' in ct or 'vnd.apple.mpegurl' in ct:
        segments = body.count(b'#EXTINF')
        return 'Playlist HLS', ('%d segmentos' % segments) if segments else 'manifiesto HLS'
    if b'<MPD' in head or 'dash+xml' in ct:
        return 'Manifiesto DASH', 'streaming adaptativo'
    if 'json' in ct or stripped.startswith((b'{', b'[')):
        try:
            data = json.loads(body.decode('utf-8', 'replace'))
        except ValueError:
            return 'JSON (ilegible)', ''
        if isinstance(data, dict):
            keys = list(data.keys())[:15]
            return 'JSON', 'claves: ' + ', '.join(str(k) for k in keys) if keys else 'objeto vacío'
        if isinstance(data, list):
            return 'JSON', 'lista de %d elementos' % len(data)
        return 'JSON', ''
    if ct.startswith('video/') or ct in ('application/octet-stream',) and body[:3] == b'\x00\x00\x00':
        return 'Vídeo', ct or 'binario'
    if b'#EXT-X-' in head:
        return 'Playlist HLS', 'variante HLS'
    if 'html' in ct or stripped.startswith((b'<html', b'<!doctype')):
        return 'HTML', 'página web (posible login/portal)'
    if ct.startswith('text/xml') or stripped.startswith(b'<?xml') or b'<tv' in head or b'<playlist' in head:
        return 'XML', 'posible EPG/XMLTV o playlist'
    return 'Otro', ct or 'desconocido'


def probe(url):
    """Probe one candidate URL. Returns a redacted result dict."""
    result = {'url': url, 'status': 'No verificada', 'http_status': None,
              'content_type': '', 'kind': '', 'detail': '', 'tls': urlsplit(url).scheme == 'https'}
    if '[oculto]' in url:
        result['status'] = 'No verificable'
        result['detail'] = 'Ruta redactada por el analizador; no se puede sondear sin la ruta real.'
        return result
    try:
        validate_probe_url(url)
    except ProbeError as exc:
        result['status'] = 'Bloqueada'
        result['detail'] = str(exc)
        return result
    opener = build_opener(_ProbeRedirects())
    request = Request(url, headers={'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity'})
    try:
        with opener.open(request, timeout=PER_TIMEOUT) as response:
            result['http_status'] = getattr(response, 'status', None) or response.getcode()
            result['content_type'] = response.headers.get('Content-Type', '')
            chunks, total = [], 0
            reader = getattr(response, 'read1', response.read)
            while total < MAX_BODY:
                chunk = reader(min(65536, MAX_BODY - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
            body = b''.join(chunks)
            kind, detail = classify_body(result['content_type'], body)
            result['kind'], result['detail'] = kind, detail
            code = result['http_status']
            result['status'] = 'Accesible' if 200 <= code < 300 else ('Redirección' if 300 <= code < 400 else 'Error HTTP')
            if not result['tls']:
                result['detail'] = (result['detail'] + ' · sin TLS').strip(' ·')
    except HTTPError as exc:
        result['http_status'] = exc.code
        result['status'] = 'Error HTTP'
        result['detail'] = {401: 'requiere autenticación', 403: 'acceso denegado', 404: 'no existe',
                            410: 'eliminado', 429: 'limitado (rate limit)'}.get(exc.code, 'error del servidor')
    except (URLError, TimeoutError, OSError):
        result['status'] = 'Sin conexión'
        result['detail'] = 'timeout, DNS o TLS; no se desactiva la verificación HTTPS.'
    except ValueError:
        result['status'] = 'No verificable'
        result['detail'] = 'URL o respuesta con formato no válido.'
    return result


def verify_candidates(urls):
    """Probe up to MAX_PROBES candidate URLs within a total time budget."""
    results = []
    deadline = time.monotonic() + TOTAL_BUDGET
    unique = list(dict.fromkeys(urls))[:MAX_PROBES]
    for url in unique:
        if time.monotonic() > deadline:
            results.append({'url': url, 'status': 'Omitida', 'detail': 'presupuesto de tiempo agotado',
                            'http_status': None, 'content_type': '', 'kind': '', 'tls': urlsplit(url).scheme == 'https'})
            continue
        results.append(probe(url))
    summary = {
        'probed': len(results),
        'accessible': sum(r['status'] == 'Accesible' for r in results),
        'video': sum(r['kind'] in ('Playlist HLS', 'Manifiesto DASH', 'Vídeo') for r in results),
        'json': sum(r['kind'].startswith('JSON') for r in results),
        'errors': sum(r['status'] in ('Error HTTP', 'Sin conexión', 'Bloqueada') for r in results),
        'note': 'Verificación de disponibilidad sin autenticación. Un 200 no concede permiso de uso; '
                'no se enviaron credenciales ni tokens del APK. Confirma autorización con el propietario.',
    }
    return {'results': results, 'summary': summary}
