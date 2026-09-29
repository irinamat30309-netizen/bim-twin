#!/usr/bin/env python3
"""BIM-Twin point-cloud cleaner sidecar.

Reads a JSON request on stdin, cleans a point cloud, writes a PLY, and prints a
JSON result on stdout. Prefers Open3D (fast, adds HPR / statistical / radius
outlier). Falls back to a pure NumPy voxel-density cleaner when Open3D is not
installed, so the feature still works with just Python + NumPy.

Request (JSON on stdin):
  {"mode":"status"}                      -> report available engines
  {"input":"a.ply","output":"b.ply","ops":[...]}

ops items:
  {"type":"crop","bbox":[minx,miny,minz,maxx,maxy,maxz]}
  {"type":"denoise","minPts":6,"factor":3.0}   # remove noise / floaters
  {"type":"statistical","k":20,"std":2.0}       # open3d; numpy -> denoise
  {"type":"radius","minPts":6,"radius":0.05}
  {"type":"downsample","voxel":0.02}
  {"type":"hpr"}                                 # open3d only (ignored in numpy)

Result: {"ok":true,"engine":"open3d"|"numpy","inputCount":N,"outputCount":M,
         "removed":K,"path":"b.ply"}
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


def _ok(engine, n0, n1, path):
    _emit({"ok": True, "engine": engine, "inputCount": int(n0),
           "outputCount": int(n1), "removed": int(n0 - n1), "path": path})
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
        in_vertex = False
        while True:
            ln = f.readline()
            if not ln:
                raise ValueError('unexpected EOF in header')
            s = ln.split(b'#', 1)[0].strip()
            if not s:
                continue
            tok = s.split()
            key = tok[0]
            if key == b'format':
                fmt = tok[1].decode()
            elif key == b'element':
                in_vertex = (tok[1] == b'vertex')
                if in_vertex:
                    count = int(tok[2])
            elif key == b'property' and in_vertex:
                if tok[1] == b'list':
                    raise ValueError('list vertex property unsupported')
                props.append((tok[2].decode(), tok[1].decode()))
            elif key == b'end_header':
                break
        if fmt is None:
            raise ValueError('no format in header')
        names = [p[0] for p in props]
        if fmt.startswith('ascii'):
            arr = np.loadtxt(f, max_rows=count)
            if arr.ndim == 1:
                arr = arr.reshape(1, -1)
            col = {names[i]: arr[:, i] for i in range(len(names))}
            xyz = np.stack([col['x'], col['y'], col['z']], axis=1).astype('f4')
            rgb = None
            if 'red' in col:
                rgb = np.stack([col['red'], col['green'], col['blue']], axis=1)
                rgb = rgb.clip(0, 255).astype('u1')
            return xyz, rgb
        endian = '<' if 'little' in fmt else '>'
        dt = np.dtype([(n, endian + _PLY_TYPES[t]) for (n, t) in props])
        data = np.fromfile(f, dtype=dt, count=count)
        xyz = np.stack([data['x'], data['y'], data['z']], axis=1).astype('f4')
        rgb = None
        if 'red' in data.dtype.names:
            r, g, b = data['red'], data['green'], data['blue']
            if r.dtype.kind == 'f':
                r, g, b = r * 255, g * 255, b * 255
            rgb = np.stack([r, g, b], axis=1).clip(0, 255).astype('u1')
        return xyz, rgb


def write_ply_numpy(path, xyz, rgb):
    import numpy as np
    n = len(xyz)
    h = ('ply\nformat binary_little_endian 1.0\nelement vertex %d\n'
         'property float x\nproperty float y\nproperty float z\n' % n)
    if rgb is not None:
        h += 'property uchar red\nproperty uchar green\nproperty uchar blue\n'
    h += 'end_header\n'
    if rgb is not None:
        dt = np.dtype([('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
                       ('red', 'u1'), ('green', 'u1'), ('blue', 'u1')])
    else:
        dt = np.dtype([('x', '<f4'), ('y', '<f4'), ('z', '<f4')])
    rec = np.empty(n, dtype=dt)
    rec['x'] = xyz[:, 0]; rec['y'] = xyz[:, 1]; rec['z'] = xyz[:, 2]
    if rgb is not None:
        rec['red'] = rgb[:, 0]; rec['green'] = rgb[:, 1]; rec['blue'] = rgb[:, 2]
    with open(path, 'wb') as f:
        f.write(h.encode('ascii'))
        rec.tofile(f)


# ---------------- NumPy cleaning ----------------
def _auto_voxel(xyz):
    import numpy as np
    n = len(xyz)
    if n < 2:
        return 1.0
    # Robust spacing estimate: use the 2..98 percentile box so stray floaters
    # (exactly what we want to drop) do not inflate the voxel size.
    lo = np.percentile(xyz, 2, axis=0)
    hi = np.percentile(xyz, 98, axis=0)
    diag = float(np.linalg.norm(hi - lo))
    if diag <= 0:
        diag = float(np.linalg.norm(xyz.max(0) - xyz.min(0))) or 1.0
    return diag / max(1.0, n ** (1.0 / 3.0))


def _clamp_voxel(xyz, voxel):
    import numpy as np
    if voxel <= 0:
        voxel = _auto_voxel(xyz)
    span = xyz.max(0) - xyz.min(0)
    for _ in range(60):
        if float((span / voxel).max()) <= 4096.0:
            break
        voxel *= 1.5
    return voxel


def voxel_density_mask(xyz, voxel, min_pts):
    import numpy as np
    mn = xyz.min(0)
    vi = np.floor((xyz - mn) / voxel).astype(np.int64)
    P = np.int64(int(vi.max()) + 2)
    key = (vi[:, 0] * P + vi[:, 1]) * P + vi[:, 2]
    uniq, counts = np.unique(key, return_counts=True)
    total = np.zeros(len(xyz), dtype=np.int64)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dz in (-1, 0, 1):
                nk = ((vi[:, 0] + dx) * P + (vi[:, 1] + dy)) * P + (vi[:, 2] + dz)
                idx = np.clip(np.searchsorted(uniq, nk), 0, len(uniq) - 1)
                valid = uniq[idx] == nk
                total += np.where(valid, counts[idx], 0)
    return total >= int(min_pts)


def voxel_downsample_np(xyz, rgb, voxel):
    import numpy as np
    mn = xyz.min(0)
    vi = np.floor((xyz - mn) / voxel).astype(np.int64)
    P = np.int64(int(vi.max()) + 2)
    key = (vi[:, 0] * P + vi[:, 1]) * P + vi[:, 2]
    _, first = np.unique(key, return_index=True)
    first = np.sort(first)
    return xyz[first], (rgb[first] if rgb is not None else None)


def run_numpy(inp, outp, ops):
    import numpy as np
    xyz, rgb = read_ply_numpy(inp)
    n0 = len(xyz)
    for op in ops:
        t = op.get('type')
        if len(xyz) == 0:
            break
        if t == 'crop':
            b = op['bbox']
            m = ((xyz[:, 0] >= b[0]) & (xyz[:, 1] >= b[1]) & (xyz[:, 2] >= b[2]) &
                 (xyz[:, 0] <= b[3]) & (xyz[:, 1] <= b[4]) & (xyz[:, 2] <= b[5]))
            xyz = xyz[m]; rgb = rgb[m] if rgb is not None else None
        elif t in ('denoise', 'statistical', 'radius'):
            voxel = float(op.get('voxel', 0) or 0)
            if voxel <= 0:
                voxel = _auto_voxel(xyz) * float(op.get('factor', 3.0))
            voxel = _clamp_voxel(xyz, voxel)
            mp = int(op.get('minPts', op.get('nb_points', 6)))
            m = voxel_density_mask(xyz, voxel, mp)
            xyz = xyz[m]; rgb = rgb[m] if rgb is not None else None
        elif t == 'auto':
            # Один вызов = максимальная чистка: несколько проходов density с нарастающим порогом.
            passes = int(op.get('passes', 3))
            base_v = _clamp_voxel(xyz, _auto_voxel(xyz) * float(op.get('factor', 1.0)))
            for _p in range(passes):
                if len(xyz) < 32:
                    break
                mp = int(op.get('minPts', 6)) + _p * 2
                m = voxel_density_mask(xyz, base_v, mp)
                removed = int((~m).sum())
                xyz = xyz[m]; rgb = rgb[m] if rgb is not None else None
                if removed <= len(xyz) * 0.0008:
                    break
        elif t == 'downsample':
            voxel = _clamp_voxel(xyz, float(op.get('voxel', 0) or 0))
            xyz, rgb = voxel_downsample_np(xyz, rgb, voxel)
        # 'hpr' unsupported in numpy fallback -> skipped
    write_ply_numpy(outp, xyz, rgb)
    _ok('numpy', n0, len(xyz), outp)


# ---------------- Open3D cleaning ----------------
def _o3d_auto_radius(o3d, pcd):
    import numpy as np
    pts = np.asarray(pcd.points)
    if len(pts) < 2:
        return 1.0
    diag = float(np.linalg.norm(pts.max(0) - pts.min(0))) or 1.0
    return diag / max(1.0, len(pts) ** (1.0 / 3.0)) * 3.0


def run_open3d(o3d, inp, outp, ops):
    import numpy as np
    pcd = o3d.io.read_point_cloud(inp)
    n0 = len(pcd.points)
    for op in ops:
        if len(pcd.points) == 0:
            break
        t = op.get('type')
        if t == 'crop':
            b = op['bbox']
            aabb = o3d.geometry.AxisAlignedBoundingBox(
                min_bound=(b[0], b[1], b[2]), max_bound=(b[3], b[4], b[5]))
            pcd = pcd.crop(aabb)
        elif t in ('denoise', 'statistical'):
            k = int(op.get('k', 20)); std = float(op.get('std', 2.0))
            pcd, _ = pcd.remove_statistical_outlier(nb_neighbors=k, std_ratio=std)
        elif t == 'radius':
            mp = int(op.get('minPts', op.get('nb_points', 6)))
            r = float(op.get('radius', 0) or 0) or _o3d_auto_radius(o3d, pcd)
            pcd, _ = pcd.remove_radius_outlier(nb_points=mp, radius=r)
        elif t == 'auto':
            # CloudCompare-grade one-shot: SOR + radius outlier + connected components (DBSCAN) + финальный SOR.
            pcd, _ = pcd.remove_statistical_outlier(nb_neighbors=int(op.get('k', 20)), std_ratio=float(op.get('std', 2.0)))
            if len(pcd.points):
                r = _o3d_auto_radius(o3d, pcd)
                pcd, _ = pcd.remove_radius_outlier(nb_points=int(op.get('minPts', 8)), radius=r)
            if len(pcd.points):
                try:
                    labels = np.array(pcd.cluster_dbscan(eps=_o3d_auto_radius(o3d, pcd) * 1.5, min_points=10))
                    if labels.size and int(labels.max()) >= 0:
                        import collections
                        cnt = collections.Counter(labels[labels >= 0].tolist())
                        big = max(cnt.values())
                        keep_lbl = set([l for l, c in cnt.items() if c >= max(50, big * 0.02)])
                        idx = [i for i, l in enumerate(labels) if l in keep_lbl]
                        if 0 < len(idx) < len(labels):
                            pcd = pcd.select_by_index(idx)
                except Exception as _e:
                    sys.stderr.write('dbscan skipped: %s\n' % _e)
            if len(pcd.points):
                pcd, _ = pcd.remove_statistical_outlier(nb_neighbors=16, std_ratio=1.5)
        elif t == 'downsample':
            v = float(op.get('voxel', 0) or 0) or _o3d_auto_radius(o3d, pcd)
            pcd = pcd.voxel_down_sample(voxel_size=v)
        elif t == 'hpr':
            pts = np.asarray(pcd.points)
            if len(pts):
                c = pts.mean(0)
                diam = float(np.linalg.norm(pts.max(0) - pts.min(0))) or 1.0
                cam = (c + np.array([0.0, 0.0, diam])).tolist()
                _, idx = pcd.hidden_point_removal(cam, diam * 100.0)
                pcd = pcd.select_by_index(idx)
    o3d.io.write_point_cloud(outp, pcd, write_ascii=False)
    _ok('open3d', n0, len(pcd.points), outp)


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        _fail('bad_request: %s' % e)
    try:
        import numpy  # noqa: F401
        has_numpy = True
    except Exception:
        has_numpy = False
    try:
        import open3d  # noqa: F401
        has_o3d = True
    except Exception:
        has_o3d = False
    if req.get('mode') == 'status':
        _emit({"ok": True, "python": sys.version.split()[0],
               "open3d": has_o3d, "numpy": has_numpy})
        return
    inp = req.get('input'); outp = req.get('output')
    ops = req.get('ops') or [{"type": "denoise"}]
    if not inp or not outp:
        _fail('input and output required')
    if has_o3d:
        try:
            import open3d as o3d
            run_open3d(o3d, inp, outp, ops)
            return
        except SystemExit:
            raise
        except Exception as e:
            sys.stderr.write('open3d failed, fallback to numpy: %s\n' % e)
    if not has_numpy:
        _fail('no_engine: install open3d or numpy (pip install open3d)')
    run_numpy(inp, outp, ops)


if __name__ == '__main__':
    main()
