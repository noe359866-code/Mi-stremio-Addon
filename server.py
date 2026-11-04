import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from analyzer import analyze, MAX_UPLOAD
from api_probe import verify_candidates, MAX_PROBES

ROOT = Path(__file__).parent / 'public'
LOCK = threading.BoundedSemaphore(1)
VERIFY_LOCK = threading.BoundedSemaphore(1)

class Handler(BaseHTTPRequestHandler):
    def reply(self, status, data, kind='application/json; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path not in ('/', '/index.html'):
            return self.reply(404, b'Not found', 'text/plain')
        self.reply(200, (ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8')

    def _read_body(self, limit):
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0 or length > limit:
            raise ValueError('Carga vacía o demasiado grande.')
        blob = self.rfile.read(length)
        if len(blob) != length:
            raise ValueError('La carga está incompleta.')
        return blob

    def _analyze(self):
        if not LOCK.acquire(blocking=False):
            return self.reply(429, json.dumps({'error': 'Hay otro análisis en curso. Intenta de nuevo.'}).encode())
        try:
            self.connection.settimeout(90)
            blob = self._read_body(MAX_UPLOAD)
            result = analyze(blob, 'archivo.apk')
            self.reply(200, json.dumps(result).encode())
        except ValueError as exc:
            self.reply(400, json.dumps({'error': str(exc)}).encode())
        except Exception:
            self.reply(400, json.dumps({'error': 'No se pudo leer el APK. Puede estar dañado o no ser compatible.'}).encode())
        finally:
            LOCK.release()

    def _verify(self):
        # Opt-in network probing of candidate APIs. Never automatic.
        if not VERIFY_LOCK.acquire(blocking=False):
            return self.reply(429, json.dumps({'error': 'Hay otra verificación en curso. Intenta de nuevo.'}).encode())
        try:
            self.connection.settimeout(120)
            payload = json.loads(self._read_body(64 * 1024).decode('utf-8'))
            urls = payload.get('urls') if isinstance(payload, dict) else None
            if not isinstance(urls, list) or not urls or not all(isinstance(u, str) for u in urls):
                raise ValueError('Envía {"urls": [...]} con las APIs candidatas a verificar.')
            if len(urls) > MAX_PROBES:
                urls = urls[:MAX_PROBES]
            self.reply(200, json.dumps(verify_candidates(urls)).encode())
        except ValueError as exc:
            self.reply(400, json.dumps({'error': str(exc)}).encode())
        except Exception:
            self.reply(400, json.dumps({'error': 'No se pudo completar la verificación.'}).encode())
        finally:
            VERIFY_LOCK.release()

    def do_POST(self):
        if self.path == '/api/analyze':
            return self._analyze()
        if self.path == '/api/verify':
            return self._verify()
        return self.reply(404, b'{}')

if __name__ == '__main__':
    print('APK Lens disponible en el puerto 3000', flush=True)
    ThreadingHTTPServer(('0.0.0.0', 3000), Handler).serve_forever()
