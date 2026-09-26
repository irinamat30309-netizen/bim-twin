#!/usr/bin/env python3
"""BIM-Twin point-cloud geometry sidecar.

Reads a JSON request on stdin, performs a geometry operation, and prints a JSON
result on stdout. Registration uses deterministic trimmed ICP with SciPy's
exact nearest-neighbour index when available or a bounded-memory, exact
NumPy fallback. Open3D/PDAL are optional for operations that need them.

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
        count = None
        props = []
        current_element = None
        vertex_seen = False
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
            elif k == b'element':
                current_element = t[1].decode()
                if current_element == 'vertex':
                    if vertex_seen:
                        raise ValueError('duplicate_vertex_element')
                    count = int(t[2])
                    if count < 0:
                        raise ValueError('invalid_vertex_count')
                    vertex_seen = True
                elif not vertex_seen:
                    # This reader consumes the first PLY data block as vertices.
                    # Refuse unusual element order rather than misreading bytes.
                    raise ValueError('vertex_element_must_be_first')
            elif k == b'property' and current_element == 'vertex' and len(t) >= 3:
                if t[1] == b'list':
                    raise ValueError('unsupported_vertex_list_property')
                name, type_name = t[2].decode(), t[1].decode()
                if type_name not in _PLY_TYPES:
                    raise ValueError('unsupported_ply_property_type:' + type_name)
                props.append((name, _PLY_TYPES[type_name]))
            elif k == b'end_header':
                break
        if fmt not in (b'ascii', b'binary_little_endian', b'binary_big_endian'):
            raise ValueError('unsupported_ply_format')
        if count is None:
            raise ValueError('missing_vertex_element')
        if not props or not all(name in [p[0] for p in props] for name in ('x', 'y', 'z')):
            raise ValueError('missing_xyz_properties')
        names = [p[0] for p in props]
        if fmt == b'ascii':
            if count:
                data = np.loadtxt(f, max_rows=count)
                if data.ndim == 1:
                    data = data.reshape(count, -1)
            else:
                data = np.empty((0, len(names)), dtype=np.float64)
            cols = {n: data[:, i] for i, n in enumerate(names)}
        else:
            dt = np.dtype([(n, ('<' if b'little' in fmt else '>') + t) for n, t in props])
            payload = f.read(count * dt.itemsize)
            if len(payload) != count * dt.itemsize:
                raise ValueError('truncated_vertex_data')
            data = np.frombuffer(payload, dtype=dt, count=count)
            cols = {n: data[n] for n in names}
    xyz = np.stack([cols['x'], cols['y'], cols['z']], axis=1).astype(np.float64)
    rgb = None
    if all(c in cols for c in ('red', 'green', 'blue')):
        rgb = np.stack([cols['red'], cols['green'], cols['blue']], axis=1).astype(np.float64)
        if rgb.size and rgb.max() <= 1.0 + 1e-6:
            rgb = rgb * 255.0
    prop_names = {n.lower(): n for n in names}
    intensity_name = next((prop_names[n] for n in ('intensity', 'scalar_intensity', 'reflectance')
                           if n in prop_names), None)
    class_name = next((prop_names[n] for n in ('classification', 'class', 'label', 'scalar_classification')
                       if n in prop_names), None)
    intensity = None
    if intensity_name is not None:
        intensity = np.asarray(cols[intensity_name], dtype=np.float64)
        if not np.isfinite(intensity).all():
            raise ValueError('non_finite_intensity')
    classification = None
    if class_name is not None:
        class_values = np.asarray(cols[class_name], dtype=np.float64)
        if (not np.isfinite(class_values).all() or
                np.any(class_values < 0) or np.any(class_values > 255) or
                np.any(class_values != np.floor(class_values))):
            raise ValueError('invalid_classification_values')
        classification = class_values.astype(np.uint8)
    finite = np.isfinite(xyz).all(axis=1)
    if not finite.all():
        xyz = xyz[finite]
        if rgb is not None:
            rgb = rgb[finite]
        if intensity is not None:
            intensity = intensity[finite]
        if classification is not None:
            classification = classification[finite]
    return xyz, rgb, intensity, classification


def write_ply_numpy(path, xyz, rgb=None, up_axis=None, crs_wkt=None,
                    double_precision=False, coordinate_frame=None,
                    intensity=None, classification=None):
    from urllib.parse import quote
    import numpy as np
    xyz = np.asarray(xyz, dtype=np.float64)
    if xyz.ndim != 2 or xyz.shape[1] != 3:
        raise ValueError('invalid_xyz_shape')
    if not np.isfinite(xyz).all():
        raise ValueError('non_finite_coordinates')
    xyz_dtype = '<f8' if double_precision else '<f4'
    xyz = np.ascontiguousarray(xyz, dtype=xyz_dtype)
    n = xyz.shape[0]
    fields = [('x', xyz_dtype), ('y', xyz_dtype), ('z', xyz_dtype)]
    arrs = [xyz[:, 0], xyz[:, 1], xyz[:, 2]]
    if rgb is not None:
        rgb = np.asarray(rgb)
        if rgb.shape != (n, 3) or not np.isfinite(rgb).all():
            raise ValueError('invalid_rgb_shape_or_values')
        rgb = np.clip(rgb, 0, 255).astype('u1')
        fields += [('red', 'u1'), ('green', 'u1'), ('blue', 'u1')]
        arrs += [rgb[:, 0], rgb[:, 1], rgb[:, 2]]
    if intensity is not None:
        intensity = np.asarray(intensity, dtype=np.float64)
        if intensity.shape != (n,) or not np.isfinite(intensity).all():
            raise ValueError('invalid_intensity_shape_or_values')
        intensity = np.asarray(intensity, dtype='<f4')
        if not np.isfinite(intensity).all():
            raise ValueError('intensity_out_of_float32_range')
        fields.append(('intensity', '<f4'))
        arrs.append(intensity)
    if classification is not None:
        class_values = np.asarray(classification, dtype=np.float64)
        if (class_values.shape != (n,) or not np.isfinite(class_values).all() or
                np.any(class_values < 0) or np.any(class_values > 255) or
                np.any(class_values != np.floor(class_values))):
            raise ValueError('invalid_classification_values')
        classification = class_values.astype('u1')
        fields.append(('classification', 'u1'))
        arrs.append(classification)
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
    if intensity is not None:
        header += 'property float intensity\n'
    if classification is not None:
        header += 'property uchar classification\n'
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
    ref, _, _, _ = read_ply_numpy(req['reference'])
    cmp, _, cmp_intensity, cmp_classification = read_ply_numpy(req['compared'])
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
                    coordinate_frame=coordinate_frame, intensity=cmp_intensity,
                    classification=cmp_classification)
    st = _stats(d)
    st.update({'ok': True, 'mode': 'deviate', 'engine': eng, 'path': req['output'],
               'scale': scale, 'points': int(cmp.shape[0]),
               'coordinateFrame': coordinate_frame,
               'georeferenced': bool(coordinate_frame == 'target-source' and output_crs)})
    _emit(st)


def run_register(req):
    import numpy as np
    src, srgb, src_intensity, src_classification = read_ply_numpy(req['source'])
    tgt, _, _, _ = read_ply_numpy(req['target'])
    if src.shape[0] < 3 or tgt.shape[0] < 3:
        _fail('empty_cloud')
    if src.ndim != 2 or tgt.ndim != 2 or src.shape[1] != 3 or tgt.shape[1] != 3:
        _fail('invalid_cloud_shape')
    if not np.isfinite(src).all() or not np.isfinite(tgt).all():
        _fail('non_finite_coordinates')
    if np.linalg.matrix_rank(src - src.mean(axis=0)) < 2 or np.linalg.matrix_rank(tgt - tgt.mean(axis=0)) < 2:
        _fail('degenerate_cloud')
    try:
        voxel = float(req.get('voxel') or 0.0)
        threshold = float(req.get('threshold') or 0.0)
        trim_fraction = float(req.get('trimFraction', 0.85))
        min_overlap = float(req.get('minOverlap', 0.05))
        max_pairs = int(req.get('maxPairs', 20000))
        max_iter = int(req.get('maxIter') or 50)
    except (TypeError, ValueError, OverflowError):
        _fail('invalid_registration_parameters')
    if not np.isfinite(voxel) or voxel < 0:
        _fail('invalid_voxel')
    if not np.isfinite(threshold) or threshold < 0:
        _fail('invalid_threshold')
    if not np.isfinite(trim_fraction) or not 0.1 <= trim_fraction <= 1.0:
        _fail('invalid_trim_fraction')
    if not np.isfinite(min_overlap) or not 0.0 < min_overlap <= 1.0:
        _fail('invalid_min_overlap')
    if max_pairs < 3 or max_pairs > 200000:
        _fail('invalid_max_pairs')
    max_iter = max(1, min(500, max_iter))
    try:
        T, registration = _icp_numpy(
            src, tgt, threshold, max_iter, voxel,
            trim_fraction=trim_fraction, min_overlap=min_overlap,
            max_pairs=max_pairs)
    except ValueError as exc:
        _fail(str(exc))
    src_h = np.hstack([src, np.ones((src.shape[0], 1))])
    moved = (src_h @ T.T)[:, :3]
    moved, output_axis, double_precision, coordinate_frame = _restore_source_coordinates(
        moved, req.get('targetFrame'))
    output_crs = req.get('outputCrsWkt') if coordinate_frame == 'target-source' else None
    write_ply_numpy(req['output'], moved, srgb, up_axis=output_axis,
                    crs_wkt=output_crs, double_precision=double_precision,
                    coordinate_frame=coordinate_frame, intensity=src_intensity,
                    classification=src_classification)
    registration.update({
        'ok': True, 'mode': 'register', 'engine': registration['engine'],
        'path': req['output'], 'transform': T.flatten().tolist(),
        'points': int(src.shape[0]), 'targetPoints': int(tgt.shape[0]),
        'coordinateFrame': coordinate_frame,
        'georeferenced': bool(coordinate_frame == 'target-source' and output_crs)
    })
    _emit(registration)


def _icp_numpy(src, tgt, threshold, max_iter, voxel, *,
               trim_fraction=0.85, min_overlap=0.05, max_pairs=20000):
    """Deterministic, trimmed coarse-to-fine rigid ICP.

    Correspondences are bounded by a distance gate, trimmed by residual rank,
    and fitted with Huber weights. The reported RMSE is over the retained
    inliers; fitness is the fraction of sampled source points inside the final
    distance gate. This is still a local ICP solver, not a global initializer.
    """
    import numpy as np
    import math
    src = np.asarray(src, dtype=np.float64)
    tgt = np.asarray(tgt, dtype=np.float64)
    if src.ndim != 2 or tgt.ndim != 2 or src.shape[1:] != (3,) or tgt.shape[1:] != (3,):
        raise ValueError('invalid_cloud_shape')
    if src.shape[0] < 3 or tgt.shape[0] < 3:
        raise ValueError('empty_cloud')
    if not np.isfinite(src).all() or not np.isfinite(tgt).all():
        raise ValueError('non_finite_coordinates')
    if np.linalg.matrix_rank(src - src.mean(axis=0)) < 2 or np.linalg.matrix_rank(tgt - tgt.mean(axis=0)) < 2:
        raise ValueError('degenerate_cloud')
    if not np.isfinite(trim_fraction) or not 0.1 <= float(trim_fraction) <= 1.0:
        raise ValueError('invalid_trim_fraction')
    if not np.isfinite(min_overlap) or not 0.0 < float(min_overlap) <= 1.0:
        raise ValueError('invalid_min_overlap')
    trim_fraction = float(trim_fraction)
    min_overlap = float(min_overlap)
    max_pairs = max(3, min(200000, int(max_pairs)))

    T = np.eye(4)
    shift = tgt.mean(axis=0) - src.mean(axis=0)
    cur = src + shift
    T[:3, 3] = shift
    if not threshold or threshold <= 0:
        span = tgt.max(0) - tgt.min(0)
        threshold = max(float(np.linalg.norm(span)) / 20.0, 1e-6)
    threshold = float(threshold)
    if not math.isfinite(threshold) or threshold <= 0:
        raise ValueError('invalid_threshold')
    max_iter = max(1, min(500, int(max_iter)))
    voxel = float(voxel or 0.0)
    if not math.isfinite(voxel) or voxel < 0:
        raise ValueError('invalid_voxel')

    sample_step = max(1, int(math.ceil(src.shape[0] / float(max_pairs))))
    sample_ids = np.arange(0, src.shape[0], sample_step, dtype=np.int64)
    if sample_ids.size < 3:
        sample_ids = np.arange(src.shape[0], dtype=np.int64)

    # Build the target index once. Never silently use the old 27-cell
    # approximation for registration: it can select a farther point whenever
    # an adjacent occupied cell happens to exist.
    tree = None
    engine = 'numpy-exact-trimmed-icp'
    try:
        from scipy.spatial import cKDTree
        tree = cKDTree(tgt)
        engine = 'scipy-trimmed-icp'
    except Exception:
        pass
    if tree is None and sample_ids.size * tgt.shape[0] > 50000000:
        raise ValueError('scipy_required_for_large_icp')

    def nearest(points):
        if tree is not None:
            d, idx = tree.query(points, k=1)
            return np.asarray(d, dtype=np.float64), np.asarray(idx, dtype=np.int64)
        # Exact bounded-memory fallback for small/medium clouds. The cap above
        # prevents an unexpectedly quadratic registration from locking the UI.
        idx = np.empty(points.shape[0], dtype=np.int64)
        dist = np.empty(points.shape[0], dtype=np.float64)
        bytes_per_query = max(1, tgt.shape[0] * 3 * np.dtype(np.float64).itemsize)
        batch = max(1, min(64, (32 * 1024 * 1024) // bytes_per_query))
        for start in range(0, points.shape[0], batch):
            end = min(points.shape[0], start + batch)
            diff = tgt[None, :, :] - points[start:end, None, :]
            d2 = np.einsum('ijk,ijk->ij', diff, diff)
            nearest_ids = np.argmin(d2, axis=1)
            idx[start:end] = nearest_ids
            dist[start:end] = np.sqrt(d2[np.arange(end - start), nearest_ids])
        return dist, idx

    initial_distances, _ = nearest(cur[sample_ids])
    initial_valid = np.isfinite(initial_distances) & (initial_distances <= threshold)
    initial_values = initial_distances[initial_valid]
    initial_fitness = float(initial_values.size / sample_ids.size)
    initial_rmse = float(np.sqrt(np.mean(initial_values * initial_values))) if initial_values.size else None

    # A distance schedule gives ICP a wider capture range first and tightens it
    # over the last passes. If voxel size is known it controls the coarse gate.
    coarse_gate = max(threshold * 4.0, voxel * 4.0)
    gates = [coarse_gate, max(threshold * 2.0, voxel * 2.0), threshold]
    total_iterations = 0
    final_converged = False
    last_rmse = float('inf')
    last_correspondences = 0
    last_inliers = 0
    last_gate = threshold
    base_budget, extra_budget = divmod(max_iter, len(gates))
    level_budgets = [base_budget + (1 if level < extra_budget else 0)
                     for level in range(len(gates))]

    for level, gate in enumerate(gates):
        previous_rmse = None
        level_converged = False
        for _ in range(level_budgets[level]):
            total_iterations += 1
            points = cur[sample_ids]
            distances, indices = nearest(points)
            valid = np.isfinite(distances) & (distances <= gate)
            valid_ids = np.flatnonzero(valid)
            correspondences = int(valid_ids.size)
            min_required = max(3, int(math.ceil(min_overlap * sample_ids.size)))
            if correspondences < min_required:
                raise ValueError('insufficient_correspondences')

            valid_dist = distances[valid_ids]
            keep_n = max(3, int(math.floor(correspondences * trim_fraction)))
            keep_n = min(keep_n, correspondences)
            if keep_n < correspondences:
                local = np.argpartition(valid_dist, keep_n - 1)[:keep_n]
                fit_ids = valid_ids[local]
            else:
                fit_ids = valid_ids

            fit_dist = distances[fit_ids]
            median = float(np.median(fit_dist))
            mad = float(np.median(np.abs(fit_dist - median))) * 1.4826
            robust_scale = max(mad, gate * 1e-4, 1e-9)
            huber_cut = max(median + 1.345 * robust_scale, 1e-9)
            weights = np.minimum(1.0, huber_cut / np.maximum(fit_dist, 1e-12))
            source_ids = sample_ids[fit_ids]
            P = cur[source_ids]
            Q = tgt[indices[fit_ids]]
            Tc = _best_fit_transform(P, Q, weights)
            cur = (cur @ Tc[:3, :3].T) + Tc[:3, 3]
            T = Tc @ T

            residual = cur[source_ids] - Q
            residual_dist = np.sqrt(np.einsum('ij,ij->i', residual, residual))
            last_rmse = float(np.sqrt(np.average(residual_dist * residual_dist, weights=weights)))
            last_correspondences = correspondences
            last_inliers = int(fit_ids.size)
            last_gate = gate
            if previous_rmse is not None and abs(previous_rmse - last_rmse) <= max(1e-9, threshold * 1e-5):
                level_converged = True
                break
            previous_rmse = last_rmse
        if level == len(gates) - 1:
            final_converged = level_converged

    final_points = cur[sample_ids]
    final_dist, _ = nearest(final_points)
    final_valid = np.isfinite(final_dist) & (final_dist <= threshold)
    valid_values = final_dist[final_valid]
    if valid_values.size < max(3, int(math.ceil(min_overlap * sample_ids.size))):
        raise ValueError('insufficient_final_overlap')
    keep_n = max(3, int(math.floor(valid_values.size * trim_fraction)))
    keep_n = min(keep_n, valid_values.size)
    if keep_n < valid_values.size:
        inlier_dist = np.partition(valid_values, keep_n - 1)[:keep_n]
    else:
        inlier_dist = valid_values
    if not np.isfinite(inlier_dist).all():
        raise ValueError('registration_failed')
    fitness = float(valid_values.size / sample_ids.size)
    inlier_ratio = float(inlier_dist.size / sample_ids.size)
    rmse = float(np.sqrt(np.mean(inlier_dist * inlier_dist)))
    median = float(np.median(inlier_dist))
    p95 = float(np.percentile(inlier_dist, 95))
    if not all(math.isfinite(x) for x in (fitness, inlier_ratio, rmse, median, p95)) or fitness <= 0:
        raise ValueError('registration_failed')

    warnings = []
    if fitness < 0.2:
        warnings.append('low_overlap')
    if not final_converged:
        warnings.append('max_iterations')
    return T, {
        'engine': engine,
        'fitness': fitness,
        'inlierRatio': inlier_ratio,
        'initialFitness': initial_fitness,
        'initialRmse': initial_rmse,
        'initialCorrespondences': int(initial_values.size),
        'rmse': rmse,
        'medianResidual': median,
        'p95Residual': p95,
        'correspondences': int(valid_values.size),
        'inliers': int(inlier_dist.size),
        'sampledSourcePoints': int(sample_ids.size),
        'iterations': int(total_iterations),
        'converged': bool(final_converged),
        'trimFraction': trim_fraction,
        'maxCorrespondenceDistance': threshold,
        'lastGate': float(last_gate),
        'warnings': warnings,
    }


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


def _best_fit_transform(P, Q, weights=None):
    import numpy as np
    P = np.asarray(P, dtype=np.float64)
    Q = np.asarray(Q, dtype=np.float64)
    if P.ndim != 2 or Q.shape != P.shape or P.shape[1] != 3 or P.shape[0] < 3:
        raise ValueError('insufficient_correspondences')
    if weights is None:
        w = np.ones(P.shape[0], dtype=np.float64)
    else:
        w = np.asarray(weights, dtype=np.float64)
        if w.shape != (P.shape[0],) or not np.isfinite(w).all() or np.any(w <= 0):
            raise ValueError('invalid_correspondence_weights')
    sum_w = float(w.sum())
    if not np.isfinite(sum_w) or sum_w <= 0:
        raise ValueError('invalid_correspondence_weights')
    cP = np.sum(P * w[:, None], axis=0) / sum_w
    cQ = np.sum(Q * w[:, None], axis=0) / sum_w
    H = (P - cP).T @ ((Q - cQ) * w[:, None])
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
    xyz, rgb, _, _ = read_ply_numpy(req['input'])
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
