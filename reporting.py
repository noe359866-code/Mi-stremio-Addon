"""Structured, escaped offline reports. APK content is always untrusted."""
import csv
import html
from collections import Counter
from pathlib import Path
from api_candidates import recommend_apis
from known_domains import classify
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


def _manifest_findings(result):
    findings = []
    manifest = result.get('manifest')
    if manifest:
        app = manifest.get('application', {})
        flags = [
            ('debuggable', 'Aplicación depurable (android:debuggable)',
             'Una build depurable permite adjuntar un depurador y extraer datos. Compila una release sin debuggable.'),
            ('allowBackup', 'Copia de seguridad permitida (android:allowBackup)',
             'Permite extraer datos de la app vía adb backup en algunos escenarios. Valora desactivarlo o usar fullBackupContent.'),
            ('usesCleartextTraffic', 'Tráfico HTTP permitido (android:usesCleartextTraffic)',
             'La app puede comunicarse sin TLS. Prefiere HTTPS y revisa networkSecurityConfig.'),
        ]
        for key, title, advice in flags:
            if app.get(key) == 'true':
                findings.append({'priority': 'Revisar', 'type': title, 'evidence': 'android:' + key + '=true',
                                 'files': ['AndroidManifest.xml'], 'recommendation': advice})
        for comp in manifest.get('components', [])[:200]:
            if comp.get('exported') == 'true' and not comp.get('permission'):
                findings.append({'priority': 'Revisar', 'type': 'Componente exportado sin permiso',
                                 'evidence': comp.get('type', '') + ' ' + comp.get('name', ''),
                                 'files': ['AndroidManifest.xml'],
                                 'recommendation': 'Un componente exportado sin permiso es accesible por otras apps. Confirma que es intencional o protégelo con un permiso.'})
    for cert in result.get('signature', {}).get('certificates', []):
        if cert.get('debug_certificate'):
            findings.append({'priority': 'Revisar', 'type': 'Firmado con certificado de depuración',
                             'evidence': cert.get('subject', ''), 'files': ['META-INF'],
                             'recommendation': 'Los certificados de depuración no identifican al autor real. Firma la release con un certificado propio.'})
    return findings


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
    result['sdks'] = []
    for d in result['domains']:
        known = classify(d['host'])
        if known:
            result['sdks'].append({'host': d['host'], 'sdk': known['sdk'], 'category': known['category'], 'url_count': d['url_count']})
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
    findings.extend(_manifest_findings(result))
    result['findings'] = findings
    result['api_candidates'] = recommend_apis(result['urls'])
    result['schema_version'] = '3.0'
    manifest = result.get('manifest') or {}
    components = manifest.get('components', [])
    result['summary'] = {'urls': len(result['urls']), 'domains': len(domains),
        'possible_apis': len(result['api_candidates']),
        'without_tls': sum(u['transport'] == 'Sin TLS' for u in result['urls']),
        'possible_secrets': len(result['secrets']),
        'sensitive_permissions': sum(p['sensitive'] for p in result['permission_details']),
        'declared_permissions': len(manifest.get('permissions_declared', [])),
        'components': len(components),
        'deep_links': len(manifest.get('deep_links', [])),
        'exported_components': sum(c.get('exported') == 'true' for c in components),
        'known_sdks': len(result['sdks']),
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
    manifest = result.get('manifest')
    if manifest:
        app = manifest.get('application', {})
        rows = [('Paquete', manifest.get('package', '')), ('Versión', (manifest.get('version_name') or '') + ' (' + (manifest.get('version_code') or '') + ')'),
                ('minSdkVersion', manifest.get('min_sdk') or ''), ('targetSdkVersion', manifest.get('target_sdk') or ''),
                ('Permisos declarados', len(manifest.get('permissions_declared', []))), ('Componentes', len(manifest.get('components', [])))]
        for key in ('name', 'debuggable', 'allowBackup', 'usesCleartextTraffic', 'networkSecurityConfig', 'extractNativeLibs', 'appComponentFactory'):
            if key in app:
                rows.append(('android:' + key, app[key]))
        sections.append('<h2 id="manifest">2. Manifiesto</h2><p>Datos leídos del XML binario estructurado. Los permisos declarados son los del manifiesto; la sección de permisos encontrados incluye además cadenas en otros archivos.</p>' + table(['Campo', 'Valor'], rows))
        comps = manifest.get('components', [])
        comp_rows = [(c.get('type', ''), c.get('name', ''), c.get('exported') or '(sin declarar)', c.get('permission') or '—', len(c.get('intent_filters', []))) for c in comps]
        deep = manifest.get('deep_links', [])
        deep_rows = [(d.get('component', ''), ', '.join(d.get('schemes', [])), ', '.join(d.get('hosts', [])) or '(cualquiera)', ', '.join(d.get('actions', []))) for d in deep]
        sections.append('<h2 id="components">3. Componentes y deep links</h2><p>Un componente exportado es accesible por otras apps. Los deep links son esquemas URI que la app declara poder abrir; no se prueban.</p>' + (table(['Tipo', 'Nombre', 'Exported', 'Permiso', 'Filtros'], comp_rows) if comp_rows else '<p>Sin componentes estructurados.</p>') + (table(['Componente', 'Esquemas', 'Hosts', 'Acciones'], deep_rows) if deep_rows else '<p>Sin deep links BROWSABLE declarados.</p>'))
    else:
        sections.append('<h2 id="manifest">2. Manifiesto</h2><p>No se pudo estructurar el manifiesto binario; solo se dispone de cadenas encontradas.</p>')
    sig = result.get('signature', {})
    schemes = ', '.join(name for name, on in (('v1 (JAR)', sig.get('v1')), ('v2', sig.get('v2')), ('v3', sig.get('v3'))) if on) or 'ninguna detectada'
    cert_rows = [(c.get('subject', ''), c.get('issuer', ''), c.get('valid_from', ''), c.get('valid_until', ''), c.get('sha256', ''), 'Sí' if c.get('debug_certificate') else 'No', 'Sí' if c.get('self_signed') else 'No') for c in sig.get('certificates', [])]
    sections.append('<h2 id="signature">4. Firma</h2><p>Esquemas detectados: ' + esc(schemes) + '. La huella identifica el certificado; no se verifica la firma ni la cadena de confianza.</p>' + (table(['Subject', 'Issuer', 'Desde', 'Hasta', 'SHA-256', 'Depuración', 'Autofirmado'], cert_rows) if cert_rows else '<p>No se extrajeron certificados (APK sin firma JAR legible o solo v2/v3).</p>'))
    sections.append('<h2 id="apis">5. APIs candidatas · Recomendaciones</h2><p>Ordenadas por indicios de ruta y dominio, no por calidad o seguridad. La confianza es heurística, no una probabilidad. Solo se muestran URLs observadas en el APK. Ninguna se ha contactado ni verificado.</p>' + (table(['Confianza / puntos', 'URL observada (redactada)', 'Por qué parece una API', 'Origen', 'Qué revisar'], [(a['confidence'] + ' / ' + str(a['score']), a['url'], '\n'.join(a['reasons']), '\n'.join(a['files']), '\n'.join(a['recommendations'])) for a in result['api_candidates']]) if result['api_candidates'] else '<p>No se encontraron candidatos con estas reglas. Esto no significa que el APK no use APIs.</p>'))
    sdk_rows = [(s['host'], s['sdk'], s['category'], s['url_count']) for s in result.get('sdks', [])]
    sections.append('<h2 id="sdks">6. SDKs y servicios conocidos</h2><p>Clasificación heurística por sufijo de dominio, sin consultas de red. Sugiere que un SDK está referenciado, no que esté activo.</p>' + (table(['Dominio', 'SDK / servicio', 'Categoría', 'URLs'], sdk_rows) if sdk_rows else '<p>Ningún dominio coincide con la lista curada.</p>'))
    sections.append('<h2 id="review">7. Elementos a revisar (no vulnerabilidades confirmadas)</h2>' + table(['Tipo', 'Evidencia redactada', 'Origen', 'Recomendación'], [(f['type'], f['evidence'], '\n'.join(f['files']), f['recommendation']) for f in result['findings']]))
    sections.append('<h2 id="domains">8. Dominios</h2>' + table(['Dominio', 'URLs', 'Categorías', 'Archivos'], [(d['host'], d['url_count'], ', '.join(d['categories']), '\n'.join(d['files'])) for d in result['domains']]))
    sections.append('<h2 id="urls">9. Conexiones por dominio</h2>' + table(['Categoría', 'URL redactada', 'Transporte', 'Archivos'], [(u['category'], u['url'], u['transport'], '\n'.join(u['files'])) for u in sorted(result['urls'], key=lambda u:(u['host'], u['category'], u['url']))]))
    sections.append('<h2 id="permissions">10. Permisos encontrados</h2><p>La presencia de una cadena no confirma que el permiso esté declarado o se use. La lista de permisos sensibles no es exhaustiva.</p>' + table(['Permiso', 'Atención', 'Descripción'], [(p['name'], 'Sensible' if p['sensitive'] else 'Contextual', p['description']) for p in result['permission_details']]))
    sections.append('<h2 id="coverage">11. Cobertura y límites</h2><p>'+esc(result['limitations'])+'</p><p>Archivos analizados: '+esc(result['files_scanned'])+' / '+esc(result['files_total'])+'</p><ul>'+''.join('<li>'+esc(w)+'</li>' for w in result['warnings'])+'</ul>')
    page = '''<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>APK Lens · Reporte</title><style>body{font:14px system-ui;background:#0c121b;color:#dde6f0;max-width:1300px;margin:auto;padding:30px}h1,h2{color:#b4f785}h2{margin-top:40px}p{line-height:1.7}nav{display:flex;gap:20px;flex-wrap:wrap}a{color:#b4f785}table{width:100%;border-collapse:collapse;background:#131d29}th,td{text-align:left;padding:12px;border:1px solid #304052;white-space:pre-wrap;overflow-wrap:anywhere;max-width:450px}th{background:#203046}.scroll{overflow:auto}code{overflow-wrap:anywhere}</style><h1>APK Lens · Reporte de inspección</h1><p>Análisis estático · No ejecuta la app · No verifica endpoints en la red</p><nav><a href="#summary">Resumen</a><a href="#manifest">Manifiesto</a><a href="#components">Componentes</a><a href="#signature">Firma</a><a href="#apis">APIs candidatas</a><a href="#sdks">SDKs</a><a href="#review">Revisión</a><a href="#domains">Dominios</a><a href="#urls">Conexiones</a><a href="#permissions">Permisos</a><a href="#coverage">Cobertura</a></nav>'''
    page += '<p>SHA-256: <code>'+esc(result['sha256'])+'</code></p>' + ''.join(sections) + '</html>'
    (directory/'report.html').write_text(page, encoding='utf-8')
    with (directory/'connections.csv').open('w', newline='', encoding='utf-8-sig') as stream:
        writer = csv.writer(stream)
        writer.writerow(['dominio', 'categoria', 'url_redactada', 'transporte', 'archivos'])
        for u in sorted(result['urls'], key=lambda x:(x['host'], x['url'])):
            cells = [u['host'], u['category'], u['url'], u['transport'], ' | '.join(u['files'])]
            writer.writerow(["'"+v if v.startswith(('=', '+', '-', '@', '\t', '\r', '\n')) else v for v in cells])
