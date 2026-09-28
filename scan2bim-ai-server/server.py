"""Scan2BIM AI server (FastAPI).

Endpoints:
  GET  /health                 -> {status, gpu, engine_ready}
  POST /reconstruct            -> multipart file=<cloud.ply> [form: mode, name]
                                  returns JSON model + base64 IFC/OBJ
  POST /reconstruct/ifc        -> same input, returns the IFC file directly

Run (on your NVIDIA PC):
  uvicorn server:app --host 0.0.0.0 --port 8765
"""
import base64
import os
import tempfile
import traceback
import json
import zipfile
import hmac

from fastapi import FastAPI, UploadFile, File, Form, Request, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.background import BackgroundTask

from app.ply_io import read_ply
from app import pipeline, dl

app = FastAPI(title='Scan2BIM AI', version='1.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['null'],
    allow_methods=['GET', 'POST', 'OPTIONS'],
    allow_headers=['Content-Type', 'X-BIMTwin-Token'],
)

AUTH_TOKEN = os.environ.get('BIMTWIN_S2B_TOKEN', '')
MAX_UPLOAD_BYTES = int(os.environ.get('BIMTWIN_S2B_MAX_UPLOAD_BYTES', str(512 * 1024 * 1024)))


@app.middleware('http')
async def require_local_token(request: Request, call_next):
    if request.method == 'OPTIONS':
        return await call_next(request)
    supplied = request.headers.get('x-bimtwin-token', '')
    if not AUTH_TOKEN:
        return JSONResponse(status_code=503, content={'ok': False, 'error': 'server_token_missing'})
    if not hmac.compare_digest(supplied, AUTH_TOKEN):
        return JSONResponse(status_code=401, content={'ok': False, 'error': 'unauthorized'})
    return await call_next(request)


async def _save_upload(upload: UploadFile):
    suffix = os.path.splitext(upload.filename or 'cloud.ply')[1] or '.ply'
    tmp_path = None
    total = 0
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tf:
            tmp_path = tf.name
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail='upload_too_large')
                tf.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail='empty_upload')
        return tmp_path
    except Exception:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise


def _cleanup(paths):
    for item in paths:
        try:
            if item and os.path.isfile(item):
                os.unlink(item)
        except OSError:
            pass


def _generated_paths(tmp_path):
    """List the whole temporary artifact family before export starts."""
    return [
        tmp_path,
        tmp_path + '-revit-ifc2x3.ifc',
        tmp_path + '-modern-ifc4.ifc',
        tmp_path + '.obj',
        tmp_path + '-revit-pack.zip',
    ]


# Checkpoint path is resolved dynamically (cwd-independent; accepts any *.pth
# dropped into the models folder). See dl.default_ckpt_path().
def _ckpt():
    return dl.default_ckpt_path()


@app.get('/health')
def health():
    gpu = False
    try:
        gpu = dl.available()
    except Exception:
        gpu = False
    return {
        'status': 'ok',
        'gpu': gpu,
        'checkpoint': os.path.exists(_ckpt()),
        'engine_ready': gpu and os.path.exists(_ckpt()),
    }


def _run(tmp_path, mode, name):
    xyz, rgb = read_ply(tmp_path)
    model = pipeline.reconstruct(xyz, rgb, mode=mode, ckpt_path=_ckpt())
    ifc_path = tmp_path + '-revit-ifc2x3.ifc'
    ifc4_path = tmp_path + '-modern-ifc4.ifc'
    obj_path = tmp_path + '.obj'
    pack_path = tmp_path + '-revit-pack.zip'
    pipeline.export(model, ifc_path=ifc_path, name=name, ifc_schema='IFC2X3')
    pipeline.export(model, ifc_path=ifc4_path, obj_path=obj_path, name=name, ifc_schema='IFC4')
    manifest = {
        'generator': 'BIM Twin Revit Export Pack', 'version': 'v1207',
        'recommended': 'model-revit-ifc2x3.ifc',
        'files': {
            'model-revit-ifc2x3.ifc': 'Open in Revit for widest compatibility',
            'model-modern-ifc4.ifc': 'Modern IFC4; link in current Revit',
            'model-appearance.obj': 'Geometry/appearance reference',
            'model-data.json': 'Detected BIM elements and measurements'
        }
    }
    with zipfile.ZipFile(pack_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(ifc_path, 'model-revit-ifc2x3.ifc')
        z.write(ifc4_path, 'model-modern-ifc4.ifc')
        z.write(obj_path, 'model-appearance.obj')
        z.writestr('model-data.json', json.dumps(model, ensure_ascii=False, indent=2))
        z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        z.writestr('README.txt',
            'BIM Twin Revit Export Pack v1207\n\n'
            'Recommended: Revit > File > Open > IFC, then select model-revit-ifc2x3.ifc.\n'
            'For a non-converting reference in newer Revit, use Link IFC with model-modern-ifc4.ifc.\n'
            'Openings are linked to walls with IfcRelVoidsElement; doors fill them with IfcRelFillsElement.\n'
            'Units: metres. Level elevation: 0.0 m.\n')
    return model, ifc_path, ifc4_path, obj_path, pack_path


@app.get('/diag')
def diag():
    """Detailed neural-engine diagnostics so the app can show the exact
    reason PTv3/GPU is or isn't working."""
    try:
        return dl.diag()
    except Exception as e:
        return JSONResponse(status_code=500,
                            content={'error': str(e), 'trace': traceback.format_exc()})


@app.post('/reconstruct')
async def reconstruct(file: UploadFile = File(...), mode: str = Form('auto'),
                      name: str = Form('Scan2BIM AI')):
    generated = []
    try:
        tmp_path = await _save_upload(file)
        generated = _generated_paths(tmp_path)
        model, ifc_path, ifc4_path, obj_path, pack_path = _run(tmp_path, mode, name)
        with open(ifc_path, 'rb') as source:
            ifc_b64 = base64.b64encode(source.read()).decode()
        with open(obj_path, 'rb') as source:
            obj_b64 = base64.b64encode(source.read()).decode()
        with open(ifc4_path, 'rb') as source:
            ifc4_b64 = base64.b64encode(source.read()).decode()
        with open(pack_path, 'rb') as source:
            pack_b64 = base64.b64encode(source.read()).decode()
        return {
            'ok': True,
            'engine': model.get('engine'),
            'ai_error': model.get('ai_error'),
            'ai_trace': model.get('ai_trace'),
            'stats': model['stats'],
            'height': model['height'],
            'floor_area': model['floor_area'],
            'model': model,
            'ifc_base64': ifc_b64,
            'ifc2x3_base64': ifc_b64,
            'ifc4_base64': ifc4_b64,
            'obj_base64': obj_b64,
            'revit_zip_base64': pack_b64,
        }
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={'ok': False, 'error': str(e),
                                                     'trace': traceback.format_exc()})
    finally:
        _cleanup(generated)


@app.post('/reconstruct/ifc')
async def reconstruct_ifc(file: UploadFile = File(...), mode: str = Form('auto'),
                         name: str = Form('Scan2BIM AI')):
    generated = []
    try:
        tmp_path = await _save_upload(file)
        generated = _generated_paths(tmp_path)
        _, ifc_path, _, _, _ = _run(tmp_path, mode, name)
        return FileResponse(ifc_path, media_type='application/octet-stream',
                            filename=(name or 'model') + '.ifc',
                            background=BackgroundTask(_cleanup, generated))
    except Exception:
        _cleanup(generated)
        raise


@app.post('/reconstruct/revit-pack')
async def reconstruct_revit_pack(file: UploadFile = File(...), mode: str = Form('auto'),
                                 name: str = Form('BIM Twin')):
    generated = []
    try:
        tmp_path = await _save_upload(file)
        generated = _generated_paths(tmp_path)
        _, _, _, _, pack_path = _run(tmp_path, mode, name)
        return FileResponse(pack_path, media_type='application/zip',
                            filename=(name or 'bim-twin') + '-revit-pack.zip',
                            background=BackgroundTask(_cleanup, generated))
    except Exception:
        _cleanup(generated)
        raise


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host=os.environ.get('HOST', '127.0.0.1'),
                port=int(os.environ.get('PORT', '8765')))
