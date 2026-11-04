"""Explainable ranking of observed URLs only; never probes endpoints."""
import re
from urllib.parse import urlsplit

RESOURCE = re.compile(r'\.(?:png|jpe?g|gif|svg|css|js|woff2?|mp4|m3u8|pdf|html?)(?:$)', re.I)

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
            'recommendations': advice, 'status': 'No verificada', 'http_method': 'Desconocido'})
    return sorted(candidates, key=lambda c: (-c['score'], c['url']))
