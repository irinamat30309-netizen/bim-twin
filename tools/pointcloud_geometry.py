#!/usr/bin/env python3
"""BIM-Twin point-cloud geometry sidecar.

Reads a JSON request on stdin, performs a geometry operation, and prints a JSON
result on stdout. Prefers Open3D / SciPy / PDAL when installed, and falls back
to pure-NumPy implementations so the core features still work with just
Python + NumPy.

Modes (JSON on stdin):
  {"mode":"status"}
      -> report available engines (numpy / scipy / open3d / pdal)
  {"mode":"deviate","reference":"model.ply","compared":"scan.ply",
   "output":"dev.ply","maxDist":0.05,"signed":false}
      -> nearest-neighbour distance from each compared point to the reference
         cloud; writes a heat-mapped PLY + returns distance statistics.
  {"mode":"register","source":"a.ply","target":"b.ply","output":"a_reg.ply",
   "voxel":0.05,"threshold":0.1,"maxIter":50}
      -> ICP alignment of source onto target; writes transformed source +
         returns 4x4 transform, fitness and RMSE.
  {"mode":"mesh","input":"cloud.ply","output":"mesh.ply","method":"poisson",
   "depth":9,"voxel":0.0}
      -> surface reconstruction (Open3D only: poisson | bpa).
  {"mode":"pdal","pipeline":{...},"output":"out.ply"}
      -> run a PDAL pipeline (PDAL python module or CLI).
"""
import sys, json

_PLY_TYPES = {
    'char': 'i1', 'int8': 'i1', 'uchar': 'u1', 'uint8': 'u1',
    'short': 'i2', 'int16': 'i2', 'ushort': 'u2', 'uint16': 'u2',
    'int': 'i4', 'int32': 'i4', 'uint': 'u4', 'uint32': 'u4',
    'float': 'f4', 'float32': 'f4', 'double': 'f8', 'float64': 'f8',
}


def _emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def _fail(msg, **extra):
    o = {"ok": False, "error": str(msg)}
    o.update(extra)
    _emit(o)
    sys.exit(0)


# ---------------- NumPy PLY IO ----------------
def read_ply_numpy(path):
    import numpy as np
    with open(path, 'rb') as f:
        if f.readline().strip() != b'ply':
            raise ValueError('not a ply file')
        fmt = None
        count = 0
        props = []
        while True:
            line = f.readline()
            if not line:
                raise ValueError('unexpected eof in header')
            t = line.strip().split()
            if not t:
                continue
            k = t[0]
            if k == b'format':
                fmt = t[1]
            elif k == b'element' and t[1] == b'vertex':
                count = int(t[2])
            elif k == b'element':
                # another element (e.g. face) - stop capturing vertex props
                pass
            elif k == b'property' and len(t) >= 3 and t[1] != b'list':
                props.append((t[2].decode(), _PLY_TYPES.get(t[1].decode(), 'f4')))
            elif k == b'end_header':
                break
        names = [p[0] for p in props]
        if fmt == b'ascii':
            data = np.loadtxt(f, max_rows=count)
            if data.ndim == 1:
                data = data.reshape(count, -1)
            cols = {n: data[:, i] for i, n in enumerate(names)}
        else:
            dt = np.dtype([(n, ('<' if b'little' in fmt else '>') + t) for n, t in props])
            data = np.frombuffer(f.read(count * dt.itemsize), dtype=dt, count=count)
            cols = {n: data[n] for n in names}
    xyz = np.stack([cols['x'], cols['y'], cols['z']], axis=1).astype(np.float64)
    rgb = None
    if all(c in cols for c in ('red', 'green', 'blue')):
        rgb = np.stack([cols['red'], cols['green'], cols['blue']], axis=1).astype(np.float64)
        if rgb.max() <= 1.0 + 1e-6:
            rgb = rgb * 255.0
    finite = np.isfinite(xyz).all(axis=1)
    if not finite.all():
        xyz = xyz[finite]
        if rgb is not None:
            rgb = rgb[finite]
    return xyz, rgb


def write_ply_numpy(path, xyz, rgb=None, up_axis=None, crs_wkt=None,
                    double_precision=False, coordinate_frame=None):
    from urllib.parse import quote
    import numpy as np
    xyz_dtype = '<f8' if double_precision else '<f4'
    xyz = np.ascontiguousarray(xyz, dtype=xyz_dtype)
    n = xyz.shape[0]
    fields = [('x', xyz_dtype), ('y', xyz_dtype), ('z', xyz_dtype)]
    arrs = [xyz[:, 0], xyz[:, 1], xyz[:, 2]]
    if rgb is not None:
        rgb = np.clip(np.asarray(rgb), 0, 255).astype('u1')
        fields += [('red', 'u1'), ('green', 'u1'), ('blue', 'u1')]
        arrs += [rgb[:, 0], rgb[:, 1], rgb[:, 2]]
    dt = np.dtype(fields)
    out = np.empty(n, dtype=dt)
    for (name, _), a in zip(fields, arrs):
        out[name] = a
    header = 'ply\nformat binary_little_endian 1.0\nelement vertex %d\n' % n
    if up_axis in ('z', 'y'):
        header = 'ply\nformat binary_little_endian 1.0\ncomment up=%s\nelement vertex %d\n' % (up_axis, n)
    if crs_wkt:
        header = header.replace('element vertex %d\n' % n,
                                'comment crs_wkt_uri=%s\nelement vertex %d\n' % (quote(str(crs_wkt), safe=''), n))
    if coordinate_frame:
        safe_frame = ''.join(c if c.isalnum() or c in '_.:-' else '_' for c in str(coordinate_frame))
        header = header.replace('element vertex %d\n' % n,
                                'comment coordinate_frame=%s\nelement vertex %d\n' % (safe_frame, n))
    coord_property = 'double' if double_precision else 'float'
    header += 'property %s x\nproperty %s y\nproperty %s z\n' % (coord_property, coord_property, coord_property)
    if rgb is not None:
        header += 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
    header += 'end_header\n'
    with open(path, 'wb') as f:
        f.write(header.encode('ascii'))
        f.write(out.tobytes())


def write_mesh_ply(path, verts, faces, rgb=None, up_axis=None, crs_wkt=None,
                   double_precision=False, coordinate_frame=None):
    from urllib.parse import quote
    import numpy as np
    xyz_dtype = '<f8' if double_precision else '<f4'
    verts = np.ascontiguousarray(verts, dtype=xyz_dtype)
    faces = np.ascontiguousarray(faces, dtype='<i4')
    nv, nf = verts.shape[0], faces.shape[0]
    lines = ['ply', 'format binary_little_endian 1.0']
    if up_axis in ('z', 'y'):
        lines.append('comment up=%s' % up_axis)
    if crs_wkt:
        lines.append('comment crs_wkt_uri=%s' % quote(str(crs_wkt), safe=''))
    if coordinate_frame:
        safe_frame = ''.join(c if c.isalnum() or c in '_.:-' else '_' for c in str(coordinate_frame))
        lines.append('comment coordinate_frame=%s' % safe_frame)
    coord_property = 'double' if double_precision else 'float'
    lines += ['element vertex %d' % nv,
              'property %s x' % coord_property, 'property %s y' % coord_property,
              'property %s z' % coord_property]
    if rgb is not None:
        rgb = np.clip(np.asarray(rgb), 0, 255).astype('u1')
        lines += ['property uchar red', 'property uchar green', 'property uchar blue']
    lines += ['element face %d' % nf, 'property list uchar int vertex_indices', 'end_header']
    with open(path, 'wb') as f:
        f.write(('\n'.join(lines) + '\n').encode('ascii'))
        if rgb is None:
            vdt = np.dtype([('x', xyz_dtype), ('y', xyz_dtype), ('z', xyz_dtype)])
            va = np.empty(nv, dtype=vdt)
            va['x'], va['y'], va['z'] = verts[:, 0], verts[:, 1], verts[:, 2]
        else:
            vdt = np.dtype([('x', xyz_dtype), ('y', xyz_dtype), ('z', xyz_dtype),
                            ('red', 'u1'), ('green', 'u1'), ('blue', 'u1')])
            va = np.empty(nv, dtype=vdt)
            va['x'], va['y'], va['z'] = verts[:, 0], verts[:, 1], verts[:, 2]
            va['red'], va['green'], va['blue'] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
        f.write(va.tobytes())
        fdt = np.dtype([('n', 'u1'), ('a', '<i4'), ('b', '<i4'), ('c', '<i4')])
        fa = np.empty(nf, dtype=fdt)
        fa['n'] = 3
        fa['a'], fa['b'], fa['c'] = faces[:, 0], faces[:, 1], faces[:, 2]
        f.write(fa.tobytes())


# ---------------- helpers ----------------
def _have(mod):
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def _jet(t):
    """Map t in [0,1] (numpy array) to an RGB heat map (blue->green->red)."""
    import numpy as np
    t = np.clip(t, 0.0, 1.0)
    r = np.clip(1.5 - np.abs(4.0 * t - 3.0), 0, 1)
    g = np.clip(1.5 - np.abs(4.0 * t - 2.0), 0, 1)
    b = np.clip(1.5 - np.abs(4.0 * t - 1.0), 0, 1)
    return np.stack([r, g, b], axis=1) * 255.0


def _nn_dist(query, ref, voxel=None):
    """Nearest-neighbour distance from each query point to the ref cloud.
    Uses scipy.cKDTree if available (exact); otherwise a NumPy voxel-grid
    approximation searching the 27 neighbouring cells."""
    import numpy as np
    try:
        from scipy.spatial import cKDTree
        d, _ = cKDTree(ref).query(query, k=1)
        return d.astype(np.float64), 'scipy'
    except Exception:
        pass
    # voxel-grid approximate NN
    if voxel is None or voxel <= 0:
        span = ref.max(0) - ref.min(0)
        diag = float(np.linalg.norm(span))
        voxel = max(diag / 256.0, 1e-6)
    origin = ref.min(0)
    rk = np.floor((ref - origin) / voxel).astype(np.int64)
    grid = {}
    for i in range(ref.shape[0]):
        grid.setdefault((int(rk[i, 0]), int(rk[i, 1]), int(rk[i, 2])), []).append(i)
    qk = np.floor((query - origin) / voxel).astype(np.int64)
    out = np.full(query.shape[0], np.inf, dtype=np.float64)
    offs = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)]
    for i in range(query.shape[0]):
        base = (int(qk[i, 0]), int(qk[i, 1]), int(qk[i, 2]))
        best = np.inf
        cand = []
        for o in offs:
            key = (base[0] + o[0], base[1] + o[1], base[2] + o[2])
            c = grid.get(key)
            if c:
                cand.extend(c)
        if cand:
            diff = ref[cand] - query[i]
            best = float(np.sqrt((diff * diff).sum(1)).min())
        else:
            diff = ref - query[i]
            best = float(np.sqrt((diff * diff).sum(1)).min())
        out[i] = best
    return out, 'numpy'


def _stats(d):
    import numpy as np
    d = np.asarray(d, dtype=np.float64)
    return {
        'count': int(d.size),
        'min': float(d.min()) if d.size else 0.0,
        'max': float(d.max()) if d.size else 0.0,
        'mean': float(d.mean()) if d.size else 0.0,
        'rms': float(np.sqrt((d * d).mean())) if d.size else 0.0,
        'p95': float(np.percentile(d, 95)) if d.size else 0.0,
        'p99': float(np.percentile(d, 99)) if d.size else 0.0,
    }


def _restore_source_coordinates(xyz, frame):
    """Map viewer-local Y-up results back to the original source coordinates."""
    import numpy as np
    if not frame or frame.get('axis') not in ('zup', 'yup'):
        return xyz, 'y', False, 'target-viewer-local'
    origin = np.asarray(frame.get('t'), dtype=np.float64)
    if origin.shape != (3,) or not np.isfinite(origin).all():
        _fail('invalid_target_frame')
    if frame['axis'] == 'zup':
        world = np.empty_like(xyz, dtype=np.float64)
        world[:, 0] = xyz[:, 0] + origin[0]
        world[:, 1] = -xyz[:, 2] + origin[1]
        world[:, 2] = xyz[:, 1] + origin[2]
        return world, 'z', True, 'target-source'
    return xyz + origin, 'y', True, 'target-source'


# ---------------- modes ----------------
def run_status():
    _emit({
        'ok': True, 'mode': 'status',
        'python': sys.version.split()[0],
        'numpy': _have('numpy'),
        'scipy': _have('scipy'),
        'open3d': _have('open3d'),
        'pdal': _have('pdal'),
    })


def run_deviate(req):
    import numpy as np
    ref, _ = read_ply_numpy(req['reference'])
    cmp, _ = read_ply_numpy(req['compared'])
    if ref.shape[0] == 0 or cmp.shape[0] == 0:
        _fail('empty_cloud')
    max_dist = float(req.get('maxDist') or 0.0)
    d, eng = _nn_dist(cmp, ref, voxel=req.get('voxel'))
    scale = max_dist if max_dist > 0 else (float(np.percentile(d, 99)) or 1.0)
    if scale <= 0:
        scale = 1.0
    rgb = _jet(d / scale)
    output, up_axis, double_precision, coordinate_frame = _restore_source_coordinates(
        cmp, req.get('comparedFrame'))
    output_crs = req.get('outputCrsWkt') if coordinate_frame == 'target-source' else None
    write_ply_numpy(req['output'], output, rgb, up_axis=up_axis,
                    crs_wkt=output_crs, double_precision=double_precision,
                    coordinate_frame=coordinate_frame)
    st = _stats(d)
    st.update({'ok': True, 'mode': 'deviate', 'engine': eng, 'path': req['output'],
               'scale': scale, 'points': int(cmp.shape[0]),
               'coordinateFrame': coordinate_frame,
               'georeferenced': bool(coordinate_frame == 'target-source' and output_crs)})
    _emit(st)


def run_register(req):
    import numpy as np
    src, srgb = read_ply_numpy(req['source'])
    tgt, _ = read_ply_numpy(req['target'])
    if src.shape[0] < 3 or tgt.shape[0] < 3:
        _fail('empty_cloud')
    if np.linalg.matrix_rank(src - src.mean(axis=0)) < 2 or np.linalg.matrix_rank(tgt - tgt.mean(axis=0)) < 2:
        _fail('degenerate_cloud')
    voxel = float(req.get('voxel') or 0.0)
    threshold = float(req.get('threshold') or 0.0)
    if not np.isfinite(voxel) or voxel < 0:
        voxel = 0.0
    if not np.isfinite(threshold) or threshold < 0:
        threshold = 0.0
    max_iter = max(1, min(1000, int(req.get('maxIter') or 50)))
    if _have('open3d'):
        import open3d as o3d
        ps = o3d.geometry.PointCloud(); ps.points = o3d.utility.Vector3dVector(src)
        pt = o3d.geometry.PointCloud(); pt.points = o3d.utility.Vector3dVector(tgt)
        if voxel > 0:
            ps_d = ps.voxel_down_sample(voxel); pt_d = pt.voxel_down_sample(voxel)
        else:
            ps_d, pt_d = ps, pt
        thr = threshold if threshold > 0 else (voxel * 1.5 if voxel > 0 else 0.1)
        init = np.eye(4)
        init[:3, 3] = tgt.mean(axis=0) - src.mean(axis=0)
        reg = o3d.pipelines.registration.registration_icp(
            ps_d, pt_d, thr, init,
            o3d.pipelines.registration.TransformationEstimationPointToPoint(),
            o3d.pipelines.registration.ICPConvergenceCriteria(max_iteration=max_iter))
        T = np.asarray(reg.transformation)
        fitness, rmse = float(reg.fitness), float(reg.inlier_rmse)
        try:
            if len(reg.correspondence_set) < 3:
                _fail('insufficient_correspondences', correspondences=len(reg.correspondence_set))
        except AttributeError:
            if fitness <= 0:
                _fail('insufficient_correspondences')
        eng = 'open3d'
    else:
        T, fitness, rmse = _icp_numpy(src, tgt, threshold, max_iter, voxel)
        eng = 'numpy'
    src_h = np.hstack([src, np.ones((src.shape[0], 1))])
    moved = (src_h @ T.T)[:, :3]
    moved, output_axis, double_precision, coordinate_frame = _restore_source_coordinates(
        moved, req.get('targetFrame'))
    output_crs = req.get('outputCrsWkt') if coordinate_frame == 'target-source' else None
    write_ply_numpy(req['output'], moved, srgb, up_axis=output_axis,
                    crs_wkt=output_crs, double_precision=double_precision,
                    coordinate_frame=coordinate_frame)
    _emit({'ok': True, 'mode': 'register', 'engine': eng, 'path': req['output'],
           'transform': T.flatten().tolist(), 'fitness': fitness, 'rmse': rmse,
           'points': int(src.shape[0]), 'coordinateFrame': coordinate_frame,
           'georeferenced': bool(coordinate_frame == 'target-source' and output_crs)})


def _icp_numpy(src, tgt, threshold, max_iter, voxel):
    import numpy as np
    T = np.eye(4)
    shift = tgt.mean(axis=0) - src.mean(axis=0)
    cur = src + shift
    T[:3, 3] = shift
    if not threshold or threshold <= 0:
        span = tgt.max(0) - tgt.min(0)
        threshold = float(np.linalg.norm(span)) / 20.0
    prev = None
    for _ in range(max_iter):
        d, _eng = _nn_dist(cur, tgt, voxel=voxel)
        # nearest target index via same grid approach but we need indices; recompute simply
        idx = _nn_index(cur, tgt, voxel)
        mask = d <= threshold
        if mask.sum() < 3:
            _fail('insufficient_correspondences', correspondences=int(mask.sum()), threshold=threshold)
        P = cur[mask]; Q = tgt[idx[mask]]
        Tc = _best_fit_transform(P, Q)
        cur = (np.hstack([cur, np.ones((cur.shape[0], 1))]) @ Tc.T)[:, :3]
        T = Tc @ T
        err = float(d[mask].mean())
        if prev is not None and abs(prev - err) < 1e-6:
            break
        prev = err
    d, _eng = _nn_dist(cur, tgt, voxel=voxel)
    rmse = float(np.sqrt((d * d).mean()))
    fitness = float((d <= threshold).mean())
    if not np.isfinite(rmse) or not np.isfinite(fitness) or fitness <= 0:
        _fail('registration_failed')
    return T, fitness, rmse


def _nn_index(query, ref, voxel):
    import numpy as np
    try:
        from scipy.spatial import cKDTree
        _, idx = cKDTree(ref).query(query, k=1)
        return idx.astype(np.int64)
    except Exception:
        pass
    if voxel is None or voxel <= 0:
        span = ref.max(0) - ref.min(0)
        voxel = max(float(np.linalg.norm(span)) / 256.0, 1e-6)
    origin = ref.min(0)
    rk = np.floor((ref - origin) / voxel).astype(np.int64)
    grid = {}
    for i in range(ref.shape[0]):
        grid.setdefault((int(rk[i, 0]), int(rk[i, 1]), int(rk[i, 2])), []).append(i)
    qk = np.floor((query - origin) / voxel).astype(np.int64)
    out = np.zeros(query.shape[0], dtype=np.int64)
    offs = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)]
    for i in range(query.shape[0]):
        base = (int(qk[i, 0]), int(qk[i, 1]), int(qk[i, 2]))
        cand = []
        for o in offs:
            c = grid.get((base[0] + o[0], base[1] + o[1], base[2] + o[2]))
            if c:
                cand.extend(c)
        if not cand:
            diff = ref - query[i]
            out[i] = int(np.argmin((diff * diff).sum(1)))
        else:
            cand = np.array(cand)
            diff = ref[cand] - query[i]
            out[i] = int(cand[np.argmin((diff * diff).sum(1))])
    return out


def _best_fit_transform(P, Q):
    import numpy as np
    cP = P.mean(0); cQ = Q.mean(0)
    H = (P - cP).T @ (Q - cQ)
    U, _, Vt = np.linalg.svd(H)
    R = Vt.T @ U.T
    if np.linalg.det(R) < 0:
        Vt[-1, :] *= -1
        R = Vt.T @ U.T
    t = cQ - R @ cP
    T = np.eye(4)
    T[:3, :3] = R; T[:3, 3] = t
    return T


def run_mesh(req):
    import numpy as np
    if not _have('open3d'):
        _fail('need_open3d', needOpen3d=True)
    import open3d as o3d
    xyz, rgb = read_ply_numpy(req['input'])
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(xyz)
    if rgb is not None:
        pcd.colors = o3d.utility.Vector3dVector(np.clip(rgb / 255.0, 0, 1))
    voxel = float(req.get('voxel') or 0.0)
    if voxel > 0:
        pcd = pcd.voxel_down_sample(voxel)
    pcd.estimate_normals()
    try:
        pcd.orient_normals_consistent_tangent_plane(10)
    except Exception:
        pass
    method = req.get('method', 'poisson')
    if method == 'bpa':
        dists = pcd.compute_nearest_neighbor_distance()
        avg = float(np.mean(dists)) if len(dists) else 0.01
        radii = [avg * 1.5, avg * 3.0]
        mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
            pcd, o3d.utility.DoubleVector(radii))
    else:
        depth = int(req.get('depth') or 9)
        mesh, dens = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            pcd, depth=depth)
        dens = np.asarray(dens)
        if dens.size:
            keep = dens > np.quantile(dens, float(req.get('trim') or 0.02))
            mesh.remove_vertices_by_mask(~keep)
    verts = np.asarray(mesh.vertices)
    faces = np.asarray(mesh.triangles)
    vcol = None
    if mesh.has_vertex_colors():
        vcol = np.asarray(mesh.vertex_colors) * 255.0
    verts, up_axis, double_precision, coordinate_frame = _restore_source_coordinates(
        verts, req.get('inputFrame'))
    output_crs = req.get('outputCrsWkt') if coordinate_frame == 'target-source' else None
    write_mesh_ply(req['output'], verts, faces, vcol, up_axis=up_axis,
                   crs_wkt=output_crs, double_precision=double_precision,
                   coordinate_frame=coordinate_frame)
    _emit({'ok': True, 'mode': 'mesh', 'engine': 'open3d', 'method': method,
           'path': req['output'], 'vertices': int(verts.shape[0]),
           'triangles': int(faces.shape[0]), 'coordinateFrame': coordinate_frame,
           'georeferenced': bool(coordinate_frame == 'target-source' and output_crs)})


def run_pdal(req):
    import subprocess, tempfile, os
    pipeline = req.get('pipeline')
    if pipeline is None:
        _fail('no_pipeline')
    if _have('pdal'):
        try:
            import pdal
            p = pdal.Pipeline(json.dumps(pipeline))
            n = p.execute()
            _emit({'ok': True, 'mode': 'pdal', 'engine': 'pdal-python',
                   'count': int(n), 'output': req.get('output')})
            return
        except Exception as e:
            _fail('pdal_python_failed:' + str(e))
    # CLI fallback
    tf = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
    json.dump(pipeline, tf); tf.close()
    try:
        r = subprocess.run(['pdal', 'pipeline', tf.name], capture_output=True, text=True)
        if r.returncode != 0:
            _fail('pdal_cli_failed', stderr=r.stderr[-800:], needPdal=True)
        _emit({'ok': True, 'mode': 'pdal', 'engine': 'pdal-cli', 'output': req.get('output')})
    except FileNotFoundError:
        _fail('need_pdal', needPdal=True)
    finally:
        try:
            os.unlink(tf.name)
        except Exception:
            pass


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        _fail('bad_request:' + str(e))
    mode = req.get('mode', 'status')
    try:
        if mode == 'status':
            run_status()
        elif mode == 'deviate':
            run_deviate(req)
        elif mode == 'register':
            run_register(req)
        elif mode == 'mesh':
            run_mesh(req)
        elif mode == 'pdal':
            run_pdal(req)
        else:
            _fail('unknown_mode:' + str(mode))
    except Exception as e:
        import traceback
        _fail(str(e), trace=traceback.format_exc()[-800:])


if __name__ == '__main__':
    main()
