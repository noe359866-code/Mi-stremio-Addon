# Investigación 2 · Brechas frente a otros repositorios y qué se implementó

## Alcance y método

Consulta directa de repositorios públicos mediante la API de GitHub (hosts
permitidos en este entorno: `github.com`, `api.github.com`, `codeload.github.com`).
Se leyeron fuentes de terceros como **referencia de formato y de cobertura**, no
se copió su código ni se añadieron sus dependencias: APK Lens sigue siendo Python
3.11+ sin dependencias externas, acotado y offline. Los proveedores de descarga
(AFTVnews, MediaFire, 1fichier) y la web de Stremio no son accesibles desde aquí;
no se afirma haberlos consultado en esta ronda.

Revisiones consultadas (SHA fijado para reproducibilidad):

| Repositorio | Revisión | Para qué se usó |
| --- | --- | --- |
| [androguard/axml](https://github.com/androguard/axml) | `5fdb362` | Formato AXML/ARSC: `ResChunk_header`, string pool UTF-8/UTF-16, chunks de etiqueta y atributos tipados. |
| [androguard/androguard](https://github.com/androguard/androguard) | `581f7a3` | APKs reales de prueba (`tests/data/APK`) y `certificate.der` como verdad de referencia. |
| [bunseokbot/dexparser](https://github.com/bunseokbot/dexparser) | `b63515d` | Cabecera DEX: `string_ids_size/off` en `0x38/0x3C`, `class_defs` en `0x60`, `string_data_item` ULEB128. |
| [MobSF/Mobile-Security-Framework-MobSF](https://github.com/MobSF/Mobile-Security-Framework-MobSF) | `9c2c086` | Qué comprueba un escáner maduro: `manifest_analysis.py` (debuggable, allowBackup, cleartext, exportados, browsable) y `cert_analysis.py` (huella, certificado de depuración, versiones de firma). |
| [dwisiswant0/apkleaks](https://github.com/dwisiswant0/apkleaks) | `dd5271a` | Cobertura de patrones de secretos (`config/regexes.json`): Google API key, AWS, Stripe, Slack, JWT, claves privadas, etc. |
| [Stremio/stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk) | `796ca01` | Protocolo de un addon Stremio (manifest/catalog/meta/stream) para la brecha de producto pendiente. |

Nota: Androguard `master` ya no parsea AXML/DEX en Python puro; delega AXML/ARSC a
`androguard/axml` y DEX a un núcleo Rust (`dex-parser`). Por eso se tomó la
librería Python independiente como referencia de formato.

## Qué faltaba (análisis de brechas)

Comparando APK Lens 2.1 con esos proyectos, las brechas reales eran:

1. **Manifiesto solo como cadenas.** Se leía el string pool pero no la estructura:
   sin paquete, versión, `minSdk/targetSdk`, permisos *declarados* (frente a
   cadenas encontradas), componentes, `exported`, ni deep links. MobSF y Androguard
   sí lo hacen. Era el pendiente explícito de `INVESTIGACION.md`.
2. **DEX escaneado como bytes crudos.** Funciona por regex, pero sin parsear
   `string_ids`/`string_data_item` se pierde precisión y no se sabe cuántas
   cadenas/clases hay ni si es multidex.
3. **`resources.arsc` sin string pool estructurado.** Las URLs de recursos se
   veían por fuerza bruta, sin lectura limpia del pool global.
4. **Sin análisis de firma.** No se detectaban esquemas v1/v2/v3, ni el
   certificado (subject/issuer/validez/huella), ni certificados de depuración.
5. **Secretos con cobertura pobre.** Solo `api_key/access_token/...=valor`.
   APKLeaks cubre decenas de formatos públicos de token que aquí no se detectaban.
6. **Sin clasificación de SDKs/dominios conocidos.** MobSF clasifica dominios;
   aquí todo dominio era "Otra URL" salvo heurística de ruta.
7. **Hallazgos de manifiesto ausentes.** `debuggable`, `allowBackup`,
   `usesCleartextTraffic` y componentes exportados sin permiso no generaban aviso.
8. **Brecha de producto: no hay addon Stremio.** El repo se llama
   `Mi-stremio-Addon` pero solo contiene el analizador. El SDK de Stremio define
   un servicio HTTP con `manifest.json` y handlers `catalog/meta/stream`; nada de
   eso existe aún. Ver más abajo.

## Qué se implementó en esta ronda

Todo en Python puro, acotado y con *fallback* al escaneo crudo si el parseo
estructural falla (los tests antiguos usan manifiestos/DEX de texto plano).

- **`axml.py`** — parser de XML binario: string pool (UTF-8/UTF-16), árbol de
  etiquetas con atributos tipados (string, boolean, int, referencia) y
  `parse_manifest()` que extrae paquete, versiones, SDK, permisos declarados y
  definidos, features, flags de `application`, componentes con `exported`/permiso/
  intent-filters, y **deep links BROWSABLE**. `arsc_strings()` lee el pool global
  de `resources.arsc`. Límites: 100k cadenas, 20k etiquetas, 1024 atributos.
- **`dex.py`** — `dex_info()` valida cabecera, recorre `string_ids`, decodifica
  ULEB128 + MUTF-8 y devuelve cadenas limpias y metadatos (versión, nº cadenas,
  nº clases). Soporta multidex (`classes*.dex`). Límite 300k cadenas.
- **`certs.py`** — lector DER mínimo (sin verificar criptografía): extrae
  certificados X.509 de bloques PKCS#7 (`META-INF/*.RSA|DSA|EC`), subject/issuer,
  validez (UTCTime y GeneralizedTime), serial, huella SHA-256, autofirmado y
  **certificado de depuración** (`CN=Android Debug`). `signing_schemes()` detecta
  el bloque `APK Sig Block 42` e IDs v2 (`0x7109871a`) / v3 (`0xf05368c0`).
- **`known_domains.py`** — lista curada offline (~50 sufijos) de SDKs/servicios
  (Firebase, Analytics, Crashlytics, publicidad, push, CDN, etc.). Heurística por
  sufijo, sin consultas de red; el sufijo más específico gana.
- **`analyzer.py`** — integra lo anterior, mantiene límites y redacción, y añade
  patrones de secretos de alto indicio (Google API key, AWS, GitHub, Slack,
  Stripe, SendGrid, Mailgun, OAuth Google, JWT, claves privadas, Twilio), siempre
  redactados.
- **`reporting.py`** — esquema **3.0**: secciones `manifest`, `dex`, `signature`,
  `sdks`; hallazgos de manifiesto y firma; resumen ampliado. HTML con 11 secciones
  (Manifiesto, Componentes/deep links, Firma, SDKs, etc.), todo escapado.
- **Web y CLI** — nuevas pestañas Manifiesto/Componentes/Firma/SDKs; resumen de CLI
  con paquete, versión, SDK, permisos declarados, componentes, deep links y firma.

### Validación con APKs reales (no sintéticos)

Descargados por API de GitHub desde `androguard/androguard@581f7a3`, sin
ejecutarlos ni guardarlos en Git:

- **`TestActivity.apk`** (174896 B, sha256 `3bb32dd5…`): paquete `tests.androguard`,
  `debuggable=true`, 1 actividad launcher, DEX 4329 cadenas/340 clases, firma v1,
  certificado `CN=Android Debug` detectado como de depuración.
- **`TestActivity_signed_both.apk`** (176928 B): firma **v1+v2** detectada; el
  certificado del bloque v2 coincide con el de referencia.
- **`certificate.der`**: subject/issuer/validez/huella **coinciden exactamente con
  OpenSSL** (`sha256 b39038a9…`, `2018-02-21 → 2118-01-28`, GeneralizedTime año
  2118, sin CN → se usa O). Sirve de verdad de referencia del parser DER.
- **`com.example.android.tvleanback.apk`** (11,3 MB, app de streaming Android TV):
  paquete y versión 1.3, min/target 21/27, 5 permisos declarados, 14 componentes
  (5 exportados), DEX 47260 cadenas/4135 clases, firma v1+v2, y se recupera su API
  de catálogo `https://storage.googleapis.com/android-tv/android_tv_videos_new.json`.
  Analizado en ~1,1 s.
- **`com.teleca.jamendo_35.apk`** (426 KB, app de música): deep link
  `http://www.jamendo.com` → `IntentDistributorActivity`, API
  `http://api.jamendo.com/get2/`, 15 componentes, 5 permisos declarados.

Pruebas automatizadas: **67 tests** (29 previos + 38 nuevos) con fixtures
sintéticos AXML/DEX/DER/PKCS#7/bloque de firma, más los casos de integración y
reportes. `python -m unittest discover -s tests -v`.

## Límites que siguen vigentes (honestidad)

- La firma se **identifica, no se verifica**: no se valida la cadena de confianza,
  ni la integridad del APK, ni Janus. Un fingerprint no autentica al autor.
- El parseo DEX es de **cadenas**, no descompila ni hace análisis de llamadas;
  código ofuscado/cifrado o construido en ejecución sigue siendo invisible.
- `resources.arsc`: solo el pool de cadenas global, no nombres de recursos por
  configuración ni valores tipados completos.
- Secretos y SDKs son **heurísticos**: falsos positivos y falsos negativos posibles.
- La clasificación de dominios es una lista curada, no una base de datos exhaustiva
  ni de reputación. No afirma que un SDK esté activo ni que la app sea segura.
- Sigue pendiente lo de la ronda 1: captura real del flujo AFTVnews `5842501`,
  aislamiento de salida contra DNS rebinding, y no exponer el servidor sin
  autenticación/TLS.

## Brecha de producto: el addon Stremio todavía no existe

El objetivo que da nombre al repo (`Mi-stremio-Addon`) requiere un **addon**, no
solo un analizador. Según `stremio-addon-sdk@796ca01`, un addon es un servicio HTTP
que expone `GET /manifest.json` y handlers `catalog`, `meta`, `stream` (y
`subtitles`), con CORS y caché. El analizador ahora produce la materia prima
(APIs candidatas, deep links, paquete), pero **falta el puente**:

1. Confirmar manualmente qué API del APK objetivo es utilizable y está autorizada
   (el reporte no verifica endpoints ni permisos de uso).
2. Construir el addon (Node.js + `stremio-addon-sdk`, o un servidor HTTP mínimo en
   Python que cumpla el protocolo) con `manifest.json` propio y handlers que
   consulten esa API confirmada.
3. Publicarlo/instalarlo en Stremio.

No se ha creado el addon en esta ronda porque depende de una API objetivo aún no
confirmada; crearlo a ciegas sería especulativo. Queda como siguiente paso
explícito, separado del analizador.
