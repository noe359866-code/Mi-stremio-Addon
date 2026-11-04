# APK Lens

Analizador estático de APK con interfaz web en español. Python 3.11+, sin dependencias externas.

## Ejecutar

```sh
python server.py
```

Abre el puerto 3000. Para pruebas: `python -m unittest discover -s tests -v`.

## Funciones

- Subida y arrastre de un APK (máximo 80 MB).
- URLs HTTP/HTTPS/WebSocket y archivos de origen, dominios, permisos Android y posibles secretos redactados.
- **Manifiesto estructurado** (XML binario): paquete, versión, `minSdk/targetSdk`, permisos declarados, componentes con `exported`/permiso, intent-filters y **deep links**.
- **DEX estructurado** (multidex): cadenas limpias vía `string_ids`, nº de clases y versión.
- **Firma**: esquemas v1/v2/v3, certificados (subject/issuer, validez, huella SHA-256) y detección de certificado de depuración. La firma se identifica, no se verifica.
- **SDKs conocidos** por dominio (Firebase, analíticas, publicidad, push, CDN…), heurística offline sin consultas de red.
- Secretos ampliados: claves Google/AWS, tokens GitHub/Slack/Stripe/SendGrid/Mailgun, JWT y claves privadas, siempre redactados.
- Filtro y exportación JSON, con hash SHA-256 del archivo.
- Sin ejecutar ni extraer archivos del APK. Procesamiento en memoria; no se guarda el APK en disco.
- Límites de archivos, tamaño expandido y hallazgos; un análisis simultáneo.

## Límites y seguridad

Solo para apps propias o con autorización. Los hallazgos no confirman APIs activas ni vulnerabilidades. Las cadenas cifradas, ofuscadas o construidas en tiempo de ejecución pueden pasar desapercibidas. No se descompila DEX ni se realiza análisis dinámico. La detección de secretos es heurística, no exhaustiva. Se ocultan consultas, fragmentos, credenciales en URLs y segmentos largos de ruta; aun así, revisa el reporte antes de compartirlo, pues los nombres de archivos o rutas podrían contener información sensible.

Servidor de desarrollo sin autenticación: no lo expongas a Internet como servicio público. Para producción añade autenticación, TLS, límites de carga en un proxy y aislamiento con cuotas de CPU y memoria. Los APK se envían al servidor, no se analizan en el navegador.

## Analizar desde GitHub Actions

1. Publica estos cambios en GitHub. El workflow manual debe existir en la rama predeterminada para aparecer en **Actions**. Después podrás seleccionar otra rama al ejecutarlo.
2. Entra en **Actions → Analizar APK → Run workflow**.
3. Completa **solo uno** de estos campos:
   - `apk_url`: enlace HTTPS público de descarga directa (por ejemplo, un APK adjunto a una Release pública propia). No sirve una página HTML de descarga. No pegues tokens, credenciales ni URLs privadas firmadas: los inputs del workflow no son secretos.
   - `apk_path`: ruta de un APK ya presente en la rama seleccionada, por ejemplo `samples/mi-app.apk`. Los APK se ignoran por defecto para no guardar binarios accidentalmente; si realmente quieres versionar uno propio, usa `git add -f samples/mi-app.apk`. Recuerda que quedará en el historial.
4. Pulsa **Run workflow** y abre la ejecución. El resumen muestra los conteos.
5. Descarga **apk-lens-report** en **Artifacts**: contiene `report.json` y `summary.md`. Caduca tras 3 días. El APK no se sube como artefacto.

El límite sigue siendo 80 MB. La descarga admite redirecciones a HTTPS público; no admite autenticación ni hosts internos. Los permisos del workflow son de solo lectura y la ejecución tiene un máximo de 10 minutos. No se ejecuta código del APK.

**Privacidad:** en repositorios públicos, los logs y reportes pueden ser visibles a otras personas. Usa un repositorio privado para APK o hallazgos sensibles y revisa las políticas de acceso de GitHub. Aunque algunos valores se ocultan, el reporte puede contener rutas y dominios sensibles. El archivo se procesa en memoria del runner; el origen puede almacenarlo y GitHub controla la infraestructura.

### CLI local

```sh
python cli.py --apk /ruta/mi-app.apk
# O una URL pública de descarga directa:
python cli.py --url https://ejemplo.com/mi-app.apk
```

Los resultados se escriben en `reports/`, excluido de Git.

## Reportes organizados (versión 2)

El artefacto de Actions ahora incluye:

- **report.html**: reporte autónomo sin scripts ni recursos externos. Descárgalo y ábrelo en tu navegador. Incluye resumen, elementos a revisar con recomendaciones, dominios, conexiones agrupadas, permisos y cobertura.
- **connections.csv**: conexiones ordenadas por dominio para hojas de cálculo, con protección frente a fórmulas en celdas.
- **report.json**: datos estructurados, campos de versiones anteriores y nuevas secciones `summary`, `domains`, `permission_details`, `findings` y `schema_version`.
- **summary.md**: resumen breve mostrado también en GitHub Actions, sin listar URLs o secretos.

La detección también reconoce cadenas ASCII en UTF-16LE, barras escapadas, hosts internos/localhost y puertos. Clasifica las conexiones como **Posible API**, **WebSocket**, **Recurso** u **Otra URL**. Estas categorías son heurísticas por ruta y esquema: no garantizan el propósito de una URL. Una referencia HTTP o un permiso sensible es un elemento para revisión, no una vulnerabilidad confirmada. No se hacen peticiones a los endpoints encontrados. Los archivos de origen por URL están limitados a cinco; el listado no es exhaustivo.

### APIs candidatas y recomendaciones

La sección **APIs candidatas** del HTML (y la pestaña equivalente en la web) muestra únicamente URLs observadas, ordenadas con reglas explicables: segmentos `/api`, `/graphql`, `/rest`, versiones como `/v2`, subdominios `api`, rutas de autenticación y nombres habituales de datos. Cada candidato incluye confianza heurística, puntos, motivos, archivos de origen y recomendaciones de revisión. Recursos estáticos y WebSockets se mantienen en conexiones pero no en este ranking.

La confianza indica fuerza de los patrones, no disponibilidad, calidad, seguridad ni permiso de uso. Un `.json` puede ser un archivo estático. No se inventan rutas, métodos ni parámetros; no se prueban endpoints y no se reutilizan credenciales. Los valores redactados no se recuperan en las recomendaciones. JSON: sección `api_candidates`, esquema `2.1`. Si no hay candidatos, se indica expresamente sin concluir que la app carece de APIs.

### Descargas desde servicios de archivos

El campo `apk_url` de Actions y `cli.py --url` aceptan:

| Origen | Soporte |
| --- | --- |
| MediaFire | Páginas públicas con botón HTML de descarga HTTPS. Se resuelve el enlace sin ejecutar JavaScript. |
| Dropbox | Enlaces compartidos públicos: se solicita `dl=1`. |
| GitHub | URLs de archivos tipo `blob` se convierten a `raw`; adjuntos públicos de Releases por su enlace de descarga directa. |
| Otros alojamientos, incluido File.io | Solo si proporcionan directamente el archivo por HTTPS o redirigen al archivo; sus páginas intermedias no se resuelven. |

Se admiten cookies en memoria y redirecciones HTTPS. Se rechazan destinos DNS privados/no globales, páginas genéricas de descarga y archivos sin cabecera ZIP. No hay soporte para login, captchas, contraseñas, cuotas premium ni páginas que exigen ejecutar JavaScript. No se garantiza compatibilidad con todos los enlaces de un servicio: sus páginas pueden cambiar. Las pruebas de MediaFire son con respuestas simuladas, no con descargas reales del proveedor.

**1fichier y otros servicios con formularios/esperas no tienen un resolvedor específico.** Usa un enlace directo autorizado. No pegues credenciales ni enlaces sensibles en inputs de Actions. La validación DNS es una defensa básica, no aislamiento de red frente a DNS rebinding: en despliegues expuestos añade control de salida de red a nivel de infraestructura.

### Código Downloader / go.aftvnews.com

En **Actions → Analizar APK → Run workflow**, completa **exactamente uno**:

- `downloader_code`: por ejemplo `5842501` (solo números).
- `apk_url`: enlace HTTPS directo o página pública compatible (también admite `https://go.aftvnews.com/5842501`).
- `apk_path`: ruta de un APK de la rama elegida.

El código se transforma en `https://go.aftvnews.com/<código>`. Se siguen redirecciones HTTP HTTPS, etiquetas HTML `meta refresh` o enlaces de destino con identificadores reconocidos. Si el destino es MediaFire, se continúa con su resolvedor. Los enlaces HTTP de **go.aftvnews.com** se actualizan a HTTPS; no se permite HTTP para otros destinos. Límite: seis pasos de resolución HTML, con detección de bucles y validación de los destinos. No se seleccionan enlaces publicitarios arbitrarios ni se ejecuta JavaScript. Si la página requiere otro mecanismo, se pide el enlace directo.

CLI:

```sh
python cli.py --code 5842501
```

La cadena código → MediaFire → APK está cubierta con respuestas simuladas. No se ha confirmado la descarga real del código `5842501`: el entorno de desarrollo no tiene acceso a ese proveedor. La compatibilidad depende del formato de respuesta actual de AFTVnews.

## Análisis estructurado (versión 3)

Además de buscar cadenas, ahora se parsean las estructuras binarias de Android
(sin dependencias externas y con *fallback* al escaneo crudo si fallan):

- **`axml.py`**: manifiesto XML binario → paquete, `versionName/versionCode`,
  `minSdk/targetSdk`, permisos declarados y definidos, flags de `application`
  (`debuggable`, `allowBackup`, `usesCleartextTraffic`, `networkSecurityConfig`…),
  componentes (`activity/service/receiver/provider`) con `exported`, permiso e
  intent-filters, y **deep links BROWSABLE**. También lee el string pool global de
  `resources.arsc`.
- **`dex.py`**: `classes*.dex` (multidex) → cadenas limpias (`string_ids` +
  ULEB128/MUTF-8), nº de clases y versión DEX.
- **`certs.py`**: certificados X.509 de `META-INF/*.RSA|DSA|EC` (PKCS#7) →
  subject/issuer, validez, serial, huella SHA-256, autofirmado y certificado de
  depuración; detección del bloque de firma v2/v3. **No verifica** la firma ni la
  cadena de confianza.
- **`known_domains.py`**: clasificación heurística offline de SDKs/servicios por
  sufijo de dominio.

El JSON pasa a **esquema 3.0** con secciones `manifest`, `dex`, `signature` y
`sdks`; el HTML añade las secciones Manifiesto, Componentes/deep links, Firma y
SDKs; la web suma pestañas equivalentes. Los hallazgos incluyen ahora
`debuggable`, `allowBackup`, `usesCleartextTraffic`, componentes exportados sin
permiso y certificado de depuración. Todo sigue redactado y escapado.

Validado con APKs reales de Androguard (TV Leanback, Jamendo, TestActivity) y con
`certificate.der` contrastado contra OpenSSL. 67 pruebas automatizadas.

## Investigación y validación

Consulta [docs/INVESTIGACION.md](docs/INVESTIGACION.md) (ronda 1) y
[docs/INVESTIGACION2.md](docs/INVESTIGACION2.md) (ronda 2: brechas frente a
Androguard, MobSF, APKLeaks y Stremio SDK, implementación y validación real).
MediaFire admite además `data-scrambled-url` Base64 y redirecciones literales restringidas a sus hosts de descarga, sin ejecutar JavaScript. Se descargan bloques de hasta 64 KiB con un presupuesto temporal y errores de proveedor redactados. Namespaces XML conocidos se separan de las conexiones de red para no alertar por tráfico inexistente.

**Nota de producto:** el repositorio se llama `Mi-stremio-Addon` pero hoy solo
contiene el analizador APK Lens. El addon Stremio en sí (servicio HTTP con
`manifest.json` y handlers `catalog/meta/stream`) sigue pendiente; depende de
confirmar una API objetivo autorizada. Ver la brecha de producto en
[docs/INVESTIGACION2.md](docs/INVESTIGACION2.md).
