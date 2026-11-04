# Revisión técnica y evidencia

## Alcance

Consulta directa de repositorios públicos mediante la API de GitHub. Google, AFTVnews y MediaFire no son accesibles desde este entorno; no se afirma haberlos consultado ni haber descargado el código 5842501. Se inspeccionaron fuentes; no se copió código de terceros ni se añadieron sus dependencias. Esta revisión no es una auditoría exhaustiva ni garantiza compatibilidad universal.

## Fuentes y conclusiones

1. [Kapowarr: MediaFire.py, revisión c191dda](https://github.com/Casvt/Kapowarr/blob/c191dda6617929c81292483a8cc07f631111dae2/backend/implementations/download_clients/MediaFire.py).
   Su implementación contempla botón `downloadButton`, atributo Base64 `data-scrambled-url` y una asignación literal a `window.location.href` con destino MediaFire. Nuestro resolvedor solo cubría href. Se añadieron las dos variantes faltantes mediante extracción textual estricta (sin evaluar JS), validación de Base64 y host `download[0-9]+.mediafire.com`. No se incorporó descarga de carpetas: el analizador espera un APK individual.

2. [Cyberdrop-DL: mediafire.py, revisión 2d8c48f](https://github.com/Cyberdrop-DL/cyberdrop-dl/blob/2d8c48f5749c1ee5ad241f1b046fe0823ea2caf7/cyberdrop_dl/crawlers/mediafire.py).
   Confirma como segunda implementación independiente la presencia de `data-scrambled-url` y el fallback al href. También distingue archivos/carpetas y errores del proveedor. Se mejoraron mensajes para 403/404/410/429 sin mostrar URLs sensibles. No se adoptaron mecanismos de impersonación, carpetas ni acceso autenticado.

3. [CPython: urllib.request, revisión 416e8d8](https://github.com/python/cpython/blob/416e8d89f57ac39f0ca8187dc6bc44f5f6ff994c/Lib/urllib/request.py).
   Se revisó el manejador de redirecciones. El proyecto mantiene validación HTTPS y destinos públicos en cada salto; urllib por sí solo no sustituye esta política. La descarga ahora usa bloques de hasta 64 KiB, 20 s de timeout por operación y presupuesto de 120 s comprobado entre lecturas. Una operación bloqueada puede exceder ese presupuesto hasta el timeout; no es un límite duro. Actions conserva su límite de trabajo de 10 minutos. No se desactiva TLS.

4. [Androguard: README y arquitectura, revisión 581f7a3](https://github.com/androguard/androguard/tree/581f7a3251545a97f66ee92b674dd810ee380a00).
   Su análisis distingue APK, AXML y DEX y no equivale a buscar cadenas. El README consultado advierte diferencias entre su árbol 5 y PyPI 4.1.4. No se añadió una dependencia sin validar versiones. Nuestro escáner sigue siendo ligero: no hace descompilación, análisis de llamadas, firma de certificados ni lectura estructurada de componentes. Los permisos siguen siendo **cadenas encontradas**, no permisos declarados confirmados. Para esa función se necesita un parser AXML completo o un backend mantenido y versionado.

5. [VesperTV: página APK](https://github.com/NoXqc/VesperTV/blob/main/docs/apk/index.html).
   Es una página externa al servicio que usa meta refresh y menciona un código Downloader. Es evidencia de ese mecanismo HTML general, **no** del formato actual de go.aftvnews.com. No se encontró en esta revisión una implementación independiente verificable del resolvedor AFTVnews. Sus selectores actuales siguen siendo provisionales y están probados con fixtures sintéticos. Si falla, usar enlace directo; no fingir resolución exitosa.

## Prueba con APK real de referencia

Se obtuvo mediante GitHub API [TestActivity.apk de Androguard](https://github.com/androguard/androguard/blob/581f7a3251545a97f66ee92b674dd810ee380a00/tests/data/APK/TestActivity.apk), sin ejecutarlo ni guardarlo en Git.

- Tamaño: 174896 bytes.
- SHA-256: `3bb32dd50129690bce850124ea120aa334e708eaa7987cf2329fd1ea0467a0eb`.
- 10 archivos leídos de 10; sin archivos omitidos.
- Se encontró una URL de namespace Android. La revisión detectó que se marcaba erróneamente como posible conexión sin TLS.
- Corrección: namespaces Android/XML conocidos pasan a **Metadatos XML**, no generan aviso de transporte inseguro ni recomendación de API. Se conserva la URL como evidencia, sin afirmar conexión.
- Esta prueba verifica compatibilidad básica con un APK real; no demuestra exhaustividad. No sustituye la prueba pendiente del código 5842501.

## Pruebas y asuntos pendientes

Pruebas unitarias para Base64, redirección literal, hosts falsificados, errores HTTP sin filtración de URL, tiempo de descarga, namespace XML, cadenas AFTVnews/MediaFire simuladas, redacción, ranking y reportes escapados.

Pendientes antes de afirmar soporte de producción: captura real del flujo 5842501, fixtures sanitizados de AFTVnews actual, pruebas de proveedores en una red permitida, parser AXML/DEX estructurado y aislamiento de salida contra DNS rebinding. La validación DNS en aplicación no evita por sí sola una segunda resolución a una IP distinta. No exponer este servidor sin autenticación y aislamiento.
