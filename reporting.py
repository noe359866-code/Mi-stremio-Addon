"""Structured, escaped offline reports. APK content is always untrusted."""
import csv
import html
from collections import Counter
from pathlib import Path
from api_candidates import recommend_apis
from urllib.parse import urlsplit

SENSITIVE_PERMISSIONS = {
    'READ_CONTACTS': 'Lectura de contactos', 'READ_SMS': 'Lectura de mensajes',
    'SEND_SMS': 'Envío de mensajes', 'RECORD_AUDIO': 'Acceso al micrófono',
    'CAMERA': 'Acceso a cámara', 'ACCESS_FINE_LOCATION': 'Ubicación precisa',
    'ACCESS_BACKGROUND_LOCATION': 'Ubicación en segundo plano',
    'READ_CALL_LOG': 'Lectura del historial de llamadas',
    'MANAGE_EXTERNAL_STORAGE': 'Acceso amplio al almacenamiento',
    'REQUEST_INSTALL_PACKAGES': 'Solicitud de instalación de paquetes',
}

def enrich(result):
    domains = {}
    for item in result['urls']:
        path = item['url'].split(item['host'], 1)[-1].lower()
        parsed = urlsplit(item['url'])
        metadata = (parsed.hostname == 'schemas.android.com' and parsed.path.startswith('/apk/')) or (parsed.hostname == 'www.w3.org' and parsed.path in ('/2001/XMLSchema', '/2001/XMLSchema-instance', '/1999/XSL/Transform'))
        if metadata:
            category = 'Metadatos XML'
        elif item['scheme'] in ('ws', 'wss'):
            category = 'WebSocket'
        elif any(x in path for x in ('/api', '/graphql', '/rest/', '/oauth', '/v1/', '/v2/', '/v3/')):
            category = 'Posible API'
        elif path.endswith(('.png', '.jpg', '.svg', '.css', '.js', '.woff', '.mp4', '.m3u8')):
            category = 'Recurso'
        else:
            category = 'Otra URL'
        item.update(category=category, transport='No aplica' if metadata else ('Sin TLS' if item['scheme'] in ('http', 'ws') else 'TLS'), confidence='heurística')
        domain = domains.setdefault(item['host'], {'host': item['host'], 'url_count': 0, 'categories': set(), 'files': set()})
        domain['url_count'] += 1
        domain['categories'].add(category)
        domain['files'].update(item['files'])
    result['domains'] = [dict(d, categories=sorted(d['categories']), files=sorted(d['files'])) for _, d in sorted(domains.items())]
    result['permission_details'] = [{'name': p, 'sensitive': p.rsplit('.', 1)[-1] in SENSITIVE_PERMISSIONS,
        'description': SENSITIVE_PERMISSIONS.get(p.rsplit('.', 1)[-1], 'Permiso encontrado; verificar uso y declaración.')} for p in result['permissions']]
    findings = []
    for item in result['urls']:
        if item['transport'] == 'Sin TLS':
            findings.append({'priority': 'Revisar', 'type': 'Referencia sin TLS', 'evidence': item['url'], 'files': item['files'],
                'recommendation': 'Verificar si se usa en ejecución; preferir HTTPS/WSS. Una cadena no demuestra tráfico real.'})
    for secret in result['secrets']:
        findings.append({'priority': 'Revisar', 'type': 'Posible secreto incrustado', 'evidence': secret['type'] + ': [oculto]', 'files': [secret['file']],
            'recommendation': 'Comprobar si es un ejemplo o una credencial real. Si es real, revocarla y evitar incrustarla.'})
    result['findings'] = findings
    result['api_candidates'] = recommend_apis(result['urls'])
    result['schema_version'] = '2.1'
    result['summary'] = {'urls': len(result['urls']), 'domains': len(domains),
        'possible_apis': len(result['api_candidates']),
        'without_tls': sum(u['transport'] == 'Sin TLS' for u in result['urls']),
        'possible_secrets': len(result['secrets']),
        'sensitive_permissions': sum(p['sensitive'] for p in result['permission_details']),
        'categories': dict(Counter(u['category'] for u in result['urls']))}
    return result


def write_reports(result, directory):
    directory = Path(directory)
    def esc(value):
        return html.escape(str(value), quote=True)
    def table(headers, rows):
        return '<div class="scroll"><table><thead><tr>' + ''.join('<th>'+esc(x)+'</th>' for x in headers) + '</tr></thead><tbody>' + ''.join('<tr>'+''.join('<td>'+esc(x)+'</td>' for x in row)+'</tr>' for row in rows) + '</tbody></table></div>'
    sections = []
    sections.append('<h2 id="summary">1. Resumen</h2>' + table(['Métrica', 'Cantidad'], [(k,v) for k,v in result['summary'].items() if k != 'categories']))
    sections.append('<h2 id="apis">APIs candidatas · Recomendaciones</h2><p>Ordenadas por indicios de ruta y dominio, no por calidad o seguridad. La confianza es heurística, no una probabilidad. Solo se muestran URLs observadas en el APK. Ninguna se ha contactado ni verificado.</p>' + (table(['Confianza / puntos', 'URL observada (redactada)', 'Por qué parece una API', 'Origen', 'Qué revisar'], [(a['confidence'] + ' / ' + str(a['score']), a['url'], '\n'.join(a['reasons']), '\n'.join(a['files']), '\n'.join(a['recommendations'])) for a in result['api_candidates']]) if result['api_candidates'] else '<p>No se encontraron candidatos con estas reglas. Esto no significa que el APK no use APIs.</p>'))
    sections.append('<h2 id="review">2. Elementos a revisar (no vulnerabilidades confirmadas)</h2>' + table(['Tipo', 'Evidencia redactada', 'Origen', 'Recomendación'], [(f['type'], f['evidence'], '\n'.join(f['files']), f['recommendation']) for f in result['findings']]))
    sections.append('<h2 id="domains">3. Dominios</h2>' + table(['Dominio', 'URLs', 'Categorías', 'Archivos'], [(d['host'], d['url_count'], ', '.join(d['categories']), '\n'.join(d['files'])) for d in result['domains']]))
    sections.append('<h2 id="urls">4. Conexiones por dominio</h2>' + table(['Categoría', 'URL redactada', 'Transporte', 'Archivos'], [(u['category'], u['url'], u['transport'], '\n'.join(u['files'])) for u in sorted(result['urls'], key=lambda u:(u['host'], u['category'], u['url']))]))
    sections.append('<h2 id="permissions">5. Permisos encontrados</h2><p>La presencia de una cadena no confirma que el permiso esté declarado o se use. La lista de permisos sensibles no es exhaustiva.</p>' + table(['Permiso', 'Atención', 'Descripción'], [(p['name'], 'Sensible' if p['sensitive'] else 'Contextual', p['description']) for p in result['permission_details']]))
    sections.append('<h2 id="coverage">6. Cobertura y límites</h2><p>'+esc(result['limitations'])+'</p><p>Archivos analizados: '+esc(result['files_scanned'])+' / '+esc(result['files_total'])+'</p><ul>'+''.join('<li>'+esc(w)+'</li>' for w in result['warnings'])+'</ul>')
    page = '''<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>APK Lens · Reporte</title><style>body{font:14px system-ui;background:#0c121b;color:#dde6f0;max-width:1300px;margin:auto;padding:30px}h1,h2{color:#b4f785}h2{margin-top:40px}p{line-height:1.7}nav{display:flex;gap:20px;flex-wrap:wrap}a{color:#b4f785}table{width:100%;border-collapse:collapse;background:#131d29}th,td{text-align:left;padding:12px;border:1px solid #304052;white-space:pre-wrap;overflow-wrap:anywhere;max-width:450px}th{background:#203046}.scroll{overflow:auto}code{overflow-wrap:anywhere}</style><h1>APK Lens · Reporte de inspección</h1><p>Análisis estático · No ejecuta la app · No verifica endpoints en la red</p><nav><a href="#summary">Resumen</a><a href="#apis">APIs candidatas</a><a href="#review">Revisión</a><a href="#domains">Dominios</a><a href="#urls">Conexiones</a><a href="#permissions">Permisos</a><a href="#coverage">Cobertura</a></nav>'''
    page += '<p>SHA-256: <code>'+esc(result['sha256'])+'</code></p>' + ''.join(sections) + '</html>'
    (directory/'report.html').write_text(page, encoding='utf-8')
    with (directory/'connections.csv').open('w', newline='', encoding='utf-8-sig') as stream:
        writer = csv.writer(stream)
        writer.writerow(['dominio', 'categoria', 'url_redactada', 'transporte', 'archivos'])
        for u in sorted(result['urls'], key=lambda x:(x['host'], x['url'])):
            cells = [u['host'], u['category'], u['url'], u['transport'], ' | '.join(u['files'])]
            writer.writerow(["'"+v if v.startswith(('=', '+', '-', '@', '\t', '\r', '\n')) else v for v in cells])
