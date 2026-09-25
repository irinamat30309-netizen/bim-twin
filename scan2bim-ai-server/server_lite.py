"""Scan2BIM AI server - LITE (Python standard library only, needs only numpy).

Why this exists:
  The FastAPI/uvicorn stack often fails to install on user machines (heavy or
  broken wheels), which left port 8765 empty (ERR_CONNECTION_REFUSED / Failed to
  fetch). This server uses ONLY the Python standard library plus numpy (which is
  already present because torch pulls it), so it starts reliably with no pip step.

Endpoints (same JSON contract as server.py):
  GET  /health       -> {status, gpu, checkpoint, engine_ready}
  POST /reconstruct  -> multipart file=<cloud.ply> [mode, name] OR raw PLY body
                        -> {ok, engine, stats, height, floor_area, model, ifc_base64, obj_base64}

Run:
  python server_lite.py          (host 127.0.0.1, port from PORT env or 8765)
"""
import base64
import json
import os
import sys
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Make sure "app" package (next to this file) is importable no matter the CWD.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from app.ply_io import read_ply
from app import pipeline, dl

import numpy as _np

CKPT = os.environ.get('S2B_CKPT', 'models/ptv3_s3dis.pth')
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '8765'))


def _json_default(o):
    if isinstance(o, _np.integer):
        return int(o)
    if isinstance(o, _np.floating):
        return float(o)
    if isinstance(o, _np.bool_):
        return bool(o)
    if isinstance(o, _np.ndarray):
        return o.tolist()
    return str(o)


def _health():
    try:
        gpu = bool(dl.available())
    except Exception:
        gpu = False
    return {
        'status': 'ok',
        'gpu': gpu,
        'checkpoint': os.path.exists(os.path.join(_HERE, CKPT)) or os.path.exists(CKPT),
        'engine_ready': gpu and (os.path.exists(os.path.join(_HERE, CKPT)) or os.path.exists(CKPT)),
        'engine_impl': 'lite',
    }


def _parse_multipart(body, ctype):
    """Minimal multipart/form-data parser. Returns {name: (filename_or_None, bytes)}."""
    fields = {}
    idx = ctype.lower().find('boundary=')
    if idx < 0:
        return fields
    boundary = ctype[idx + len('boundary='):].strip()
    if ';' in boundary:
        boundary = boundary.split(';', 1)[0].strip()
    boundary = boundary.strip('"')
    delim = b'--' + boundary.encode('latin1')
    for part in body.split(delim):
        if not part or part in (b'--\r\n', b'--', b'\r\n', b'\r\n--\r\n'):
            continue
        if part.startswith(b'\r\n'):
            part = part[2:]
        if part.endswith(b'\r\n'):
            part = part[:-2]
        if part == b'--' or part.endswith(b'--'):
            part = part[:-2] if part.endswith(b'--') else part
        hdr_end = part.find(b'\r\n\r\n')
        if hdr_end < 0:
            continue
        raw_headers = part[:hdr_end].decode('latin1', 'replace')
        data = part[hdr_end + 4:]
        name = None
        filename = None
        for line in raw_headers.split('\r\n'):
            if line.lower().startswith('content-disposition'):
                for seg in line.split(';'):
                    seg = seg.strip()
                    if seg.lower().startswith('name='):
                        name = seg[5:].strip().strip('"')
                    elif seg.lower().startswith('filename='):
                        filename = seg[9:].strip().strip('"')
        if name is None:
            continue
        fields[name] = (filename, data)
    return fields


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _send(self, code, obj):
        data = json.dumps(obj, default=_json_default).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        path = (self.path or '/').split('?', 1)[0].rstrip('/') or '/'
        if path == '/health':
            self._send(200, _health())
        else:
            self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        path = (self.path or '/').split('?', 1)[0].rstrip('/') or '/'
        want_ifc = (path == '/reconstruct/ifc')
        if path not in ('/reconstruct', '/reconstruct/ifc'):
            self._send(404, {'ok': False, 'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0') or '0')
            body = self.rfile.read(length) if length > 0 else b''
            ctype = self.headers.get('Content-Type', '') or ''
            mode = 'auto'
            name = 'Scan2BIM AI'
            fname = 'cloud.ply'
            filedata = None
            if 'multipart/form-data' in ctype.lower():
                fields = _parse_multipart(body, ctype)
                if 'file' in fields:
                    fname = fields['file'][0] or 'cloud.ply'
                    filedata = fields['file'][1]
                if 'mode' in fields:
                    mode = (fields['mode'][1] or b'').decode('utf-8', 'replace').strip() or 'auto'
                if 'name' in fields:
                    name = (fields['name'][1] or b'').decode('utf-8', 'replace').strip() or name
            else:
                filedata = body  # raw PLY fallback
            if not filedata:
                self._send(400, {'ok': False, 'error': 'no PLY file in request'})
                return
            suffix = os.path.splitext(fname or 'cloud.ply')[1] or '.ply'
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tf:
                tf.write(filedata)
                tmp_path = tf.name
            xyz, rgb = read_ply(tmp_path)
            model = pipeline.reconstruct(xyz, rgb, mode=mode, ckpt_path=CKPT)
            ifc_path = tmp_path + '.ifc'
            obj_path = tmp_path + '.obj'
            pipeline.export(model, ifc_path=ifc_path, obj_path=obj_path, name=name)
            if want_ifc:
                blob = open(ifc_path, 'rb').read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Disposition', 'attachment; filename="' + (name or 'model') + '.ifc"')
                self.send_header('Content-Length', str(len(blob)))
                self.end_headers()
                try:
                    self.wfile.write(blob)
                except Exception:
                    pass
                return
            ifc_b64 = base64.b64encode(open(ifc_path, 'rb').read()).decode()
            obj_b64 = base64.b64encode(open(obj_path, 'rb').read()).decode()
            self._send(200, {
                'ok': True,
                'engine': model.get('engine'),
                'stats': model['stats'],
                'height': model['height'],
                'floor_area': model['floor_area'],
                'model': model,
                'ifc_base64': ifc_b64,
                'obj_base64': obj_b64,
            })
        except Exception as e:
            self._send(500, {'ok': False, 'error': str(e), 'trace': traceback.format_exc()})

    def log_message(self, fmt, *args):
        try:
            sys.stderr.write('[lite] ' + (fmt % args) + '\n')
        except Exception:
            pass


def main():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    sys.stderr.write('Scan2BIM LITE server (stdlib) listening on http://%s:%d\n' % (HOST, PORT))
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass


if __name__ == '__main__':
    main()
