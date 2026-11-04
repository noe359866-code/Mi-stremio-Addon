"""Command-line entry point for local use and GitHub Actions."""
import argparse
import json
import os
from pathlib import Path
from analyzer import MAX_UPLOAD, analyze
from reporting import write_reports
from downloader import download, DownloadError


def main():
    parser = argparse.ArgumentParser(description='Analiza un APK sin ejecutarlo.')
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--apk', help='Ruta de un APK local')
    source.add_argument('--url', help='URL HTTPS directa o enlace público compatible (MediaFire/Dropbox)')
    parser.add_argument('--output', default='reports')
    args = parser.parse_args()
    try:
        if args.url:
            blob = download(args.url)
        else:
            with Path(args.apk).open('rb') as stream:
                blob = stream.read(MAX_UPLOAD + 1)
        result = analyze(blob, 'archivo.apk')
        out = Path(args.output)
        out.mkdir(parents=True, exist_ok=True)
        (out / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        write_reports(result, out)
        summary = '\n'.join([
            '# APK Lens · Resultado', '',
            f"- URLs: {len(result['urls'])}",
            f"- Dominios: {len(set(u['host'] for u in result['urls']))}",
            f"- APIs candidatas ordenadas (heurística): {result['summary']['possible_apis']}",
            f"- Referencias sin TLS: {result['summary']['without_tls']}",
            f"- Permisos: {len(result['permissions'])}",
            f"- Posibles secretos: {len(result['secrets'])}",
            f"- Archivos analizados: {result['files_scanned']} / {result['files_total']}",
            f"- SHA-256: `{result['sha256']}`", '',
            'Descarga el artefacto **apk-lens-report** y abre report.html para ver el reporte organizado. También incluye JSON y CSV.', '',
            result['limitations'], '',
            f"Archivos omitidos/avisos: {len(result['warnings'])} (consulta el JSON).", '',
        ])
        (out / 'summary.md').write_text(summary, encoding='utf-8')
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
                stream.write(summary)
        print('Análisis completado. Reporte guardado; no se muestran URLs ni secretos en el log.')
    except DownloadError as exc:
        parser.exit(1, str(exc) + '\n')
    except Exception:
        # Do not echo exceptions: download errors can include sensitive signed URLs.
        parser.exit(1, 'No se pudo analizar el APK. Revisa el origen, el formato y el límite de 80 MB.\n')


if __name__ == '__main__':
    main()
