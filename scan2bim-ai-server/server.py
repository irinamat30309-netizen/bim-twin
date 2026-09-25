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

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware

from app.ply_io import read_ply
from app import pipeline, dl

app = FastAPI(title='Scan2BIM AI', version='1.0')
app.add_middleware(
    CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'],
)

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
    try:
        suffix = os.path.splitext(file.filename or 'cloud.ply')[1] or '.ply'
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tf:
            tf.write(await file.read())
            tmp_path = tf.name
        model, ifc_path, ifc4_path, obj_path, pack_path = _run(tmp_path, mode, name)
        ifc_b64 = base64.b64encode(open(ifc_path, 'rb').read()).decode()
        obj_b64 = base64.b64encode(open(obj_path, 'rb').read()).decode()
        ifc4_b64 = base64.b64encode(open(ifc4_path, 'rb').read()).decode()
        pack_b64 = base64.b64encode(open(pack_path, 'rb').read()).decode()
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
    except Exception as e:
        return JSONResponse(status_code=500, content={'ok': False, 'error': str(e),
                                                     'trace': traceback.format_exc()})


@app.post('/reconstruct/ifc')
async def reconstruct_ifc(file: UploadFile = File(...), mode: str = Form('auto'),
                         name: str = Form('Scan2BIM AI')):
    suffix = os.path.splitext(file.filename or 'cloud.ply')[1] or '.ply'
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tf:
        tf.write(await file.read())
        tmp_path = tf.name
    _, ifc_path, _, _, _ = _run(tmp_path, mode, name)
    return FileResponse(ifc_path, media_type='application/octet-stream',
                        filename=(name or 'model') + '.ifc')


@app.post('/reconstruct/revit-pack')
async def reconstruct_revit_pack(file: UploadFile = File(...), mode: str = Form('auto'),
                                 name: str = Form('BIM Twin')):
    suffix = os.path.splitext(file.filename or 'cloud.ply')[1] or '.ply'
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tf:
        tf.write(await file.read())
        tmp_path = tf.name
    _, _, _, _, pack_path = _run(tmp_path, mode, name)
    return FileResponse(pack_path, media_type='application/zip',
                        filename=(name or 'bim-twin') + '-revit-pack.zip')


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', '8765')))
