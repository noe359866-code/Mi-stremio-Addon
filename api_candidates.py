"""Explainable ranking of observed URLs only; never probes endpoints.

Tuned for video/streaming APKs: HLS/DASH manifests and video routes are promoted
to candidates with a `kind` label. Probing is a separate, opt-in step (api_probe).
"""
import re
from urllib.parse import urlsplit

# Truly static resources are excluded; video manifests/files are NOT, because for
# video apps they are the streaming endpoints worth reviewing.
RESOURCE = re.compile(r'\.(?:png|jpe?g|gif|svg|css|js|woff2?|pdf|html?|ico|ttf|otf)(?:$)', re.I)
VIDEO_EXT = re.compile(r'\.(?:m3u8|mpd|mp4|ts|m4s|mp3|aac|webm|mkv|flv)(?:$)', re.I)
VIDEO_ROUTES = [
    (r'(?:^|/)(?:video|videos|vod|movie|movies|film|films)(?:/|$)', 4, 'Ruta de vídeo/películas'),
    (r'(?:^|/)(?:stream|streams|streaming|live|play|watch|player)(?:/|$)', 4, 'Ruta de streaming/reproducción'),
    (r'(?:^|/)(?:series|serie|season|seasons|episode|episodes|tv|channel|channels)(?:/|$)', 3, 'Ruta de series/canales'),
    (r'(?:^|/)(?:hls|dash|manifest|playlist|media|content|title|titles)(?:/|$)', 3, 'Ruta de manifiesto/contenido'),
    (r'(?:^|/)(?:catalog|catalogo|epg|guide|xmltv)(?:/|$)', 3, 'Ruta de catálogo/EPG'),
    (r'(?:^|/)(?:player_api|get|xmltv)\.php$', 4, 'API tipo Xtream Codes (player_api/get.php)'),
]


def _kind(path, host, reasons):
    if VIDEO_EXT.search(path) or any('streaming' in r or 'vídeo' in r or 'manifiesto' in r or 'series' in r for r in reasons):
        return 'Vídeo/Streaming'
    if any('autenticación' in r for r in reasons):
        return 'Autenticación'
    if any('catálogo' in r or 'datos' in r for r in reasons):
        return 'Catálogo/Datos'
    return 'API'


def recommend_apis(urls):
    candidates = []
    for item in urls:
        parsed = urlsplit(item['url'])
        path, host = parsed.path.lower(), parsed.hostname or ''
        if item.get('category') == 'Metadatos XML' or RESOURCE.search(path) or parsed.scheme in ('ws', 'wss'):
            continue
        score, reasons = 0, []
        for pattern, points, reason in [
            (r'(?:^|/)api(?:/|$)', 4, 'Segmento /api en la ruta'),
            (r'(?:^|/)graphql(?:/|$)', 5, 'Ruta GraphQL'),
            (r'(?:^|/)rest(?:/|$)', 4, 'Segmento REST'),
            (r'(?:^|/)v\d+(?:/|$)', 3, 'Ruta versionada'),
            (r'(?:^|/)(?:oauth2?|token|login|auth)(?:/|$)', 2, 'Ruta posiblemente relacionada con autenticación'),
            (r'(?:^|/)(?:search|catalog|movies|series|users|products|episodes)(?:/|$)', 1, 'Ruta con nombre habitual de datos'),
        ]:
            if re.search(pattern, path):
                score += points
                reasons.append(reason)
        for pattern, points, reason in VIDEO_ROUTES:
            if re.search(pattern, path):
                score += points
                reasons.append(reason)
        if VIDEO_EXT.search(path):
            score += 4
            reasons.append('Extensión de vídeo/manifiesto (' + VIDEO_EXT.search(path).group().lstrip('.') + ')')
        if re.search(r'(?:^|\.)(?:api|graphql)(?:\.|$)', host):
            score += 3
            reasons.append('Subdominio asociado a APIs')
        if path.endswith('.json'):
            score += 1
            reasons.append('Ruta con extensión JSON (puede ser un archivo estático)')
        if not score:
            continue
        confidence = 'Alta' if score >= 6 else 'Media' if score >= 3 else 'Baja'
        advice = ['Revisar los archivos de origen y confirmar el uso en el código.',
                  'Consultar documentación y autorización del proveedor antes de integrar; no asumir acceso público.',
                  'El método HTTP, los parámetros y la autenticación no se pueden deducir de esta URL.']
        if any('autenticación' in r for r in reasons):
            advice.append('Posible endpoint de autenticación: no reutilizar tokens ni credenciales del APK.')
        if parsed.scheme == 'http':
            advice.append('Referencia sin TLS: verificar soporte HTTPS con el propietario.')
        candidates.append({'url': item['url'], 'host': host, 'confidence': confidence,
            'score': score, 'reasons': reasons, 'files': item['files'],
            'recommendations': advice, 'status': 'No verificada', 'http_method': 'Desconocido',
            'kind': _kind(path, host, reasons)})
    return sorted(candidates, key=lambda c: (-c['score'], c['url']))
