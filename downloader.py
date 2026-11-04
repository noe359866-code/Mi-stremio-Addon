"""Public HTTPS downloads and explicit shared-link resolvers; no JS execution."""
import re
import base64
import binascii
import time
import ipaddress
import socket
from html.parser import HTMLParser
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin
from urllib.request import HTTPRedirectHandler, HTTPCookieProcessor, Request, build_opener
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from analyzer import MAX_UPLOAD

MAX_PAGE = 2 * 1024 * 1024

class DownloadError(ValueError):
    pass


def validate_url(url):
    p = urlsplit(url)
    if p.scheme != 'https' or not p.hostname or p.username or p.password or p.port not in (None, 443):
        raise DownloadError('Usa una URL HTTPS pública, sin credenciales y con puerto estándar.')
    addresses = socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise DownloadError('No se permiten destinos internos o privados.')


class PublicRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def downloader_url(code):
    code = code.strip()
    if not re.fullmatch(r'[0-9]{1,10}', code):
        raise DownloadError('El código Downloader debe contener entre 1 y 10 dígitos.')
    return 'https://go.aftvnews.com/' + code


def normalize_link(url):
    p = urlsplit(url)
    if p.hostname == 'go.aftvnews.com' and p.scheme == 'http':
        url = urlunsplit(('https', p.netloc, p.path, p.query, p.fragment))
        p = urlsplit(url)
    if p.hostname in ('dropbox.com', 'www.dropbox.com'):
        query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k not in ('dl', 'raw')]
        return urlunsplit((p.scheme, p.netloc, p.path, urlencode(query + [('dl', '1')]), ''))
    if p.hostname == 'github.com':
        parts = p.path.split('/')
        if len(parts) >= 6 and parts[3] == 'blob':
            parts[3] = 'raw'
            return urlunsplit((p.scheme, p.netloc, '/'.join(parts), p.query, ''))
    return url


class MediaFirePage(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'a' and a.get('id') == 'downloadButton':
            if a.get('data-scrambled-url'):
                try:
                    encoded = a['data-scrambled-url']
                    if len(encoded) <= 16384:
                        self.links.append(base64.b64decode(encoded, validate=True).decode('utf-8'))
                except (ValueError, binascii.Error, UnicodeError):
                    pass
            if a.get('href'):
                self.links.append(a['href'])


def mediafire_target(page, base):
    parser = MediaFirePage()
    parser.feed(page)
    # A literal redirect is parsed as text, never evaluated as JavaScript.
    parser.links.extend(re.findall(r"window\.location\.href\s*=\s*['\"](https://download[0-9]+\.mediafire\.com/[^'\"\s]+)['\"]", page))
    for link in parser.links:
        target = urljoin(base, link)
        try:
            p = urlsplit(target)
            if (p.scheme == 'https' and p.hostname
                    and re.fullmatch(r'download[0-9]+\.mediafire\.com', p.hostname)
                    and not p.username and not p.password and p.port in (None, 443)):
                return target
        except ValueError:
            continue
    raise DownloadError('MediaFire no ofrece un enlace público compatible. Puede requerir captcha, contraseña o haber cambiado su página. Usa una descarga directa autorizada.')


class AFTVPage(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.targets = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'meta' and a.get('http-equiv', '').lower() == 'refresh':
            match = re.search(r"(?:^|;)\s*url\s*=\s*(.+)$", a.get('content', ''), re.I)
            if match:
                self.targets.append(match.group(1).strip().strip("\"'"))
        if tag == 'a' and a.get('id') in ('redirect-link', 'redirectLink', 'download-link', 'downloadLink') and a.get('href'):
            self.targets.append(a['href'])


def aftv_target(page, base):
    parser = AFTVPage()
    parser.feed(page)
    targets = {urljoin(base, target) for target in parser.targets}
    if len(targets) != 1:
        raise DownloadError('Downloader no ofrece un destino inequívoco compatible. Usa el enlace directo; no se ejecuta JavaScript ni se eluden captchas.')
    target = targets.pop()
    if target == base or urlsplit(target).scheme != 'https':
        raise DownloadError('Downloader devolvió un destino no compatible; usa el enlace HTTPS directo.')
    return target


def _download(url):
    url = normalize_link(url)
    opener = build_opener(PublicRedirects(), HTTPCookieProcessor(CookieJar()))
    deadline = time.monotonic() + 120
    seen = set()
    for _ in range(6):
        url = normalize_link(url)
        if url in seen:
            raise DownloadError('Se detectó un bucle de redirecciones.')
        seen.add(url)
        validate_url(url)
        request = Request(url, headers={'User-Agent': 'APK-Lens/2.1', 'Accept-Encoding': 'identity'})
        with opener.open(request, timeout=20) as response:
            final = response.geturl()
            validate_url(final)
            content_type = response.headers.get('Content-Type', '').lower()
            is_html = 'text/html' in content_type or 'application/xhtml' in content_type
            limit = MAX_PAGE if is_html else MAX_UPLOAD
            size = response.headers.get('Content-Length')
            if size and int(size) > limit:
                raise DownloadError('La descarga supera el límite permitido (APK: 80 MB; página: 2 MB).')
            chunks, total = [], 0
            while True:
                if time.monotonic() > deadline:
                    raise DownloadError('La descarga excedió el tiempo máximo de 120 segundos.')
                # read1 avoids waiting for a complete large buffer on slow streams.
                reader = getattr(response, 'read1', response.read)
                chunk = reader(min(65536, limit + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > limit:
                    raise DownloadError('La descarga supera el límite permitido.')
            blob = b''.join(chunks)
        if len(blob) > limit:
            raise DownloadError('La descarga supera el límite permitido.')
        looks_html = blob.lstrip()[:100].lower().startswith((b'<!doctype html', b'<html'))
        if is_html or looks_html:
            host = urlsplit(final).hostname or ''
            if host == 'go.aftvnews.com':
                if len(blob) > MAX_PAGE:
                    raise DownloadError('La página supera los 2 MB.')
                url = aftv_target(blob.decode('utf-8', 'replace'), final)
                continue
            if host in ('mediafire.com', 'www.mediafire.com'):
                if len(blob) > MAX_PAGE:
                    raise DownloadError('La página supera los 2 MB.')
                url = mediafire_target(blob.decode('utf-8', 'replace'), final)
                continue
            raise DownloadError('El enlace devolvió una página web, no un APK. Este servicio requiere una URL directa o un método de descarga no compatible. No se eluden captchas ni contraseñas.')
        if not blob.startswith(b'PK\x03\x04'):
            raise DownloadError('La descarga no parece un APK/ZIP. Revisa que el archivo sea público y el enlace sea correcto.')
        return blob
    raise DownloadError('Se alcanzó el límite de resolución de enlaces.')


def download(url):
    try:
        return _download(url)
    except DownloadError:
        raise
    except HTTPError as exc:
        messages = {403: 'El proveedor denegó la descarga (403); puede requerir autorización o bloquear descargas automatizadas.',
                    404: 'El enlace o archivo no existe (404).',
                    410: 'El enlace ha caducado o el archivo fue eliminado (410).',
                    429: 'El proveedor limitó las solicitudes (429). Intenta más tarde.'}
        raise DownloadError(messages.get(exc.code, 'El proveedor devolvió un error HTTP.')) from None
    except (URLError, TimeoutError, OSError):
        raise DownloadError('No se pudo conectar al proveedor: revisa disponibilidad, DNS o TLS. No se desactiva la verificación HTTPS.') from None
    except ValueError:
        raise DownloadError('El enlace o las cabeceras de descarga no tienen un formato válido.') from None
