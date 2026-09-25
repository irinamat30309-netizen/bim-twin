"""Orchestrator: point cloud -> BIM model dict -> IFC/OBJ.

Mode 'ai'   : PointTransformerV3 semantic segmentation (GPU) -> per-class geometry.
Mode 'geom' : deterministic geometric pipeline (CPU) -> geometry.
Mode 'auto' : try 'ai', fall back to 'geom' if the DL stack/GPU is unavailable.

Returns the same model dict shape in every mode so ifc_writer / obj_writer stay simple.
"""
import numpy as np
from . import geom
from . import dl
from . import cloud2bim
from . import pipes as pipes_mod
from . import cables as cables_mod
from .ifc_writer import write_ifc

AI_MAX_INPUT_POINTS = 4_000_000


def _prepare_bounded_input(xyz, rgb=None, max_points=AI_MAX_INPUT_POINTS):
    """Systematic, deterministic sample with exact XYZ/RGB alignment."""
    xyz = np.asarray(xyz)
    if xyz.shape[0] <= max_points:
        return xyz, None if rgb is None else np.asarray(rgb), 1
    step = int(np.ceil(xyz.shape[0] / float(max_points)))
    idx = np.arange(0, xyz.shape[0], step, dtype=np.int64)
    return xyz[idx], None if rgb is None else np.asarray(rgb)[idx], step


def _obj_from_model(model, path):
    lines = ['# BIM-Twin Scan2BIM AI export']
    vcount = 0

    def box(cx, cy, cz, hx, hy, hz):
        nonlocal vcount
        corners = [(-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0),
                   (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
        base = vcount
        for (dx, dy, dz) in corners:
            lines.append(f'v {cx+dx:.4f} {cy+dy:.4f} {cz+dz:.4f}')
            vcount += 1
        faces = [(1, 2, 3, 4), (5, 6, 7, 8), (1, 2, 6, 5),
                 (2, 3, 7, 6), (3, 4, 8, 7), (4, 1, 5, 8)]
        for f in faces:
            lines.append('f ' + ' '.join(str(base + k) for k in f))

    h = model['height']
    for w in model['walls']:
        cx = (w['p0'][0] + w['p1'][0]) / 2
        cy = (w['p0'][1] + w['p1'][1]) / 2
        length = np.hypot(w['p1'][0] - w['p0'][0], w['p1'][1] - w['p0'][1])
        ang = np.arctan2(w['p1'][1] - w['p0'][1], w['p1'][0] - w['p0'][0])
        # approximate as axis-aligned-ish box rotated: emit as thin box in local then skip rotation for OBJ preview
        box(cx, cy, 0, max(length / 2, 0.05), max(w['thickness'] / 2, 0.02), h)
    for o in model['objects']:
        box(o['cx'], o['cy'], o['base'], o['hx'], o['hy'], o['hz'])
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    return path


def _model_from_labels(xyz, labels, voxel=0.03):
    """Convert S3DIS semantic labels into a BIM model dict using geom helpers."""
    rng = np.random.default_rng(12345)
    C = dl.CLASS_IDX
    up, floor, ceil = geom.detect_up_axis(xyz)
    plan_ax = [i for i in range(3) if i != up]
    v = xyz[:, up]
    floor_pts = xyz[labels == C['floor']]
    ceil_pts = xyz[labels == C['ceiling']]
    if floor_pts.shape[0] > 100:
        floor = float(np.median(floor_pts[:, up]))
    if ceil_pts.shape[0] > 100:
        ceil = float(np.median(ceil_pts[:, up]))
    height = ceil - floor
    wall_mask = labels == C['wall']
    wpts = xyz[wall_mask]
    band_up = wpts[:, up]
    walls = geom.detect_walls(wpts[:, plan_ax], max(voxel * 2, 0.05), floor, ceil, band_up, rng) if wpts.shape[0] > 50 else []
    pmin = xyz[:, plan_ax].min(0); pmax = xyz[:, plan_ax].max(0)
    # objects: structural + furniture + clutter classes
    obj_classes = [C['column'], C['beam'], C['table'], C['chair'], C['sofa'],
                   C['bookcase'], C['board'], C['clutter']]
    obj_mask = np.isin(labels, obj_classes)
    objects = []
    Po = xyz[obj_mask]
    if Po.shape[0] > 50:
        clusters = geom._cluster_voxels(Po, max(voxel * 3, 0.12))
        for comp in clusters:
            if comp.size < 50:
                continue
            pts = Po[comp]
            mn = pts.min(0); mx = pts.max(0)
            if (mx[up] - mn[up]) < 0.2:
                continue
            objects.append({
                'cx': float((mn[plan_ax[0]] + mx[plan_ax[0]]) / 2 - pmin[0]),
                'cy': float((mn[plan_ax[1]] + mx[plan_ax[1]]) / 2 - pmin[1]),
                'base': float(mn[up] - floor),
                'hx': float((mx[plan_ax[0]] - mn[plan_ax[0]]) / 2),
                'hy': float((mx[plan_ax[1]] - mn[plan_ax[1]]) / 2),
                'hz': float(mx[up] - mn[up]),
                'points': int(comp.size),
            })

    def to_xy(p):
        return [float(p[0] - pmin[0]), float(p[1] - pmin[1])]

    return {
        'up_axis': int(up), 'floor': 0.0, 'ceil': float(height), 'height': float(height),
        'walls': [{'p0': to_xy(w['p0']), 'p1': to_xy(w['p1']),
                   'thickness': w['thickness'], 'length': w['length']} for w in walls],
        'pipes': [],
        'objects': objects,
        'floor_area': float((pmax[0] - pmin[0]) * (pmax[1] - pmin[1])),
        'footprint': [[0.0, 0.0], [float(pmax[0] - pmin[0]), float(pmax[1] - pmin[1])]],
        'stats': {'wall_count': len(walls), 'pipe_count': 0, 'object_count': len(objects)},
        'engine': 'ai',
    }


def _full_geometric(xyz, rgb=None, voxel=0.03):
    """Cloud2BIM-style walls/slabs/openings + cylinder pipes + cable polylines +
    clustered objects. Pure NumPy(+SciPy) so it always runs (CPU)."""
    m = cloud2bim.reconstruct(xyz, rgb, voxel=voxel)
    up = m['up_axis']
    plan_ax = m['plan_ax']
    floor = m['floor_abs']
    ceil = m['ceil_abs']
    pmin = m['pmin']
    xyz, rgb, aux_stride = _prepare_bounded_input(xyz, rgb, 1_500_000)
    xyz = np.asarray(xyz, dtype=np.float64)
    m.setdefault('stats', {})['geometry_aux_points'] = int(xyz.shape[0])
    m['stats']['geometry_aux_stride'] = int(aux_stride)
    m['pipes'] = pipes_mod.detect_pipes(xyz, rgb, up, plan_ax, floor, ceil,
                                        m['walls'], pmin, voxel=voxel)
    m['pipe_groups'] = pipes_mod.group_pipes(m['pipes'])
    m['services'] = pipes_mod.detect_services(xyz, rgb, up, plan_ax, floor, ceil,
                                               pmin, voxel=voxel)
    m['cables'] = cables_mod.detect_cables(xyz, up, plan_ax, floor, ceil, pmin, voxel=voxel, rgb=rgb)
    try:
        geo = geom.reconstruct(xyz, voxel=voxel)
        m['objects'] = geo.get('objects', [])
    except Exception:
        m['objects'] = []
    m['stats']['pipe_count'] = len(m['pipes'])
    m['stats']['pipe_group_count'] = len(m['pipe_groups'])
    m['stats']['service_count'] = len(m['services'])
    m['stats']['cable_count'] = len(m['cables'])
    m['stats']['object_count'] = len(m['objects'])
    m['engine'] = 'cloud2bim'
    return m


def _refine_objects_with_instances(model, xyz, instances, class_ids):
    """Replace generic clustered objects with Mask3D instance boxes (defensive)."""
    try:
        up = model['up_axis']
        plan_ax = model['plan_ax']
        pmin = np.array(model['pmin'])
        floor = model['floor_abs']
        objs = []
        for iid in np.unique(instances):
            if iid < 0:
                continue
            sel = instances == iid
            if sel.sum() < 60:
                continue
            pts = xyz[sel]
            mn = pts.min(0); mx = pts.max(0)
            if (mx[up] - mn[up]) < 0.2:
                continue
            objs.append({
                'cx': float((mn[plan_ax[0]] + mx[plan_ax[0]]) / 2 - pmin[0]),
                'cy': float((mn[plan_ax[1]] + mx[plan_ax[1]]) / 2 - pmin[1]),
                'base': float(mn[up] - floor),
                'hx': float((mx[plan_ax[0]] - mn[plan_ax[0]]) / 2),
                'hy': float((mx[plan_ax[1]] - mn[plan_ax[1]]) / 2),
                'hz': float(mx[up] - mn[up]),
                'points': int(sel.sum()),
            })
        if objs:
            model['objects'] = objs
            model['stats']['object_count'] = len(objs)
            model['engine'] = 'cloud2bim+mask3d'
    except Exception as e:  # pragma: no cover - never break the geometric result
        print(f'[pipeline] instance refine skipped: {e}')
    return model


def _semantic_wall_support(wp2d, w):
    """Return (support_points, coverage_fraction) of semantic wall points along a
    wall segment. wp2d: (N,2) wall-class points in plan coords relative to pmin.
    w: a model wall with p0/p1 in the same plan coords."""
    p0 = np.asarray(w['p0'], dtype=np.float64)
    p1 = np.asarray(w['p1'], dtype=np.float64)
    seg = p1 - p0
    L = float(np.hypot(seg[0], seg[1]))
    if L < 1e-6 or wp2d.shape[0] == 0:
        return 0, 0.0
    t = np.clip(((wp2d - p0) @ seg) / (L * L), 0.0, 1.0)
    proj = p0[None, :] + t[:, None] * seg[None, :]
    d = np.hypot(wp2d[:, 0] - proj[:, 0], wp2d[:, 1] - proj[:, 1])
    band = max(float(w.get('thickness', 0.2)), 0.12) + 0.20  # +20cm tolerance
    near = d <= band
    support = int(near.sum())
    if support == 0:
        return 0, 0.0
    # coverage: fraction of ~25cm bins along the wall that contain a near point
    nbins = max(4, int(round(L / 0.25)))
    tb = np.clip((t[near] * nbins).astype(np.int64), 0, nbins - 1)
    coverage = float(len(np.unique(tb))) / float(nbins)
    return support, coverage


def _refine_with_semantic(model, xyz, labels):
    """Use PTv3 S3DIS labels to ACTUALLY correct the geometric BIM: drop phantom
    walls that have no semantic wall points along them, and fix room height from
    the segmented floor/ceiling. Never raises; on any problem the geometric
    model is returned unchanged."""
    try:
        C = dl.CLASS_IDX
        xyz = np.asarray(xyz, dtype=np.float64)
        n = min(len(labels), xyz.shape[0])
        labels = np.asarray(labels)[:n]
        xyz = xyz[:n]
        counts = {name: int((labels == idx).sum()) for name, idx in C.items()}
        model.setdefault('stats', {})['semantic_counts'] = counts
        model['semantic_available'] = True
        model['stats']['semantic_wall_points'] = counts.get('wall', 0)
        model['stats']['semantic_beam_points'] = counts.get('beam', 0)
        model['stats']['semantic_column_points'] = counts.get('column', 0)

        up = int(model.get('up_axis', 2))
        plan_ax = list(model.get('plan_ax') or [i for i in range(3) if i != up])
        pm = model.get('pmin', None)
        if pm is None:
            pm = xyz[:, plan_ax].min(0)
        pmin = np.asarray(pm, dtype=np.float64).ravel()

        # (1) Height correction from the segmented floor & ceiling planes.
        fpts = xyz[labels == C['floor']]
        cpts = xyz[labels == C['ceiling']]
        if fpts.shape[0] > 200 and cpts.shape[0] > 200:
            fz = float(np.median(fpts[:, up]))
            cz = float(np.median(cpts[:, up]))
            h = cz - fz
            if 1.8 <= h <= 12.0:  # sane indoor storey height
                model['height'] = round(h, 3)
                model['ceil'] = round(h, 3)
                model['stats']['semantic_height'] = round(h, 3)

        # (2) Prune phantom walls not supported by semantic wall points. This is
        # the direct fix for false walls (e.g. a wall the scan does not contain):
        # PTv3 marks real walls, so a geometric wall with no wall-class points
        # along it is removed.
        wpts = xyz[labels == C['wall']]
        walls = model.get('walls') or []
        if wpts.shape[0] >= 500 and walls:
            wp2d = np.stack([wpts[:, plan_ax[0]] - pmin[0],
                             wpts[:, plan_ax[1]] - pmin[1]], axis=1)
            kept, removed = [], []
            for w in walls:
                support, coverage = _semantic_wall_support(wp2d, w)
                w = dict(w)
                w['semantic_support'] = support
                w['semantic_coverage'] = round(coverage, 3)
                # A real wall has points spread along most of its length.
                if support >= 30 and coverage >= 0.35:
                    kept.append(w)
                else:
                    removed.append(w)
            # Safety net: only apply pruning if it leaves a plausible model and
            # does not wipe out everything (guards against a bad segmentation).
            if kept and removed and len(kept) >= max(1, len(walls) // 3):
                model['walls'] = kept
                model['stats']['wall_count'] = len(kept)
                model['stats']['semantic_walls_removed'] = len(removed)

        model['stats']['semantic_refined'] = True
        if model.get('engine'):
            model['engine'] = str(model['engine']) + '+ptv3'
        else:
            model['engine'] = 'ptv3'
    except Exception as e:  # pragma: no cover
        print(f'[pipeline] semantic refine skipped: {e}')
    return model


def reconstruct(xyz, rgb=None, mode='auto', ckpt_path=None):
    """Always build the strong geometric model, then optionally refine object
    separation with Mask3D instance segmentation when the GPU stack is present.
    mode: 'geom' forces CPU-only; 'ai'/'auto' try Mask3D then fall back."""
    model = _full_geometric(xyz, rgb)
    if mode in ('auto', 'ai'):
        # (a) PTv3 semantic segmentation (GPU) -- additive, fully defensive.
        try:
            ai_xyz, ai_rgb, sample_step = _prepare_bounded_input(xyz, rgb)
            model.setdefault('stats', {})['ai_input_points'] = int(ai_xyz.shape[0])
            model['stats']['ai_input_stride'] = int(sample_step)
            labels = dl.segment(ai_xyz, ai_rgb, ckpt_path=ckpt_path)
            model = _refine_with_semantic(model, ai_xyz, labels)
        except dl.DLUnavailable as e:
            model['ai_error'] = f'{e}'
            if mode == 'ai':
                print(f'[pipeline] PTv3 semantic unavailable ({e}); geometric only')
        except Exception as e:  # pragma: no cover - never break the result
            import traceback as _tb
            model['ai_error'] = f'{type(e).__name__}: {e}'
            model['ai_trace'] = _tb.format_exc()[-1400:]
            print(f'[pipeline] PTv3 semantic error ({e}); geometric only')
        # (b) Optional Mask3D instance separation (not configured by default).
        try:
            instances, class_ids = dl.segment_instances(xyz, rgb, ckpt_path=ckpt_path)
            model = _refine_objects_with_instances(model, np.asarray(xyz, dtype=np.float64),
                                                   instances, class_ids)
        except dl.DLUnavailable:
            pass
        except Exception as e:  # pragma: no cover
            print(f'[pipeline] instance refine error ({e})')
    return model


def export(model, ifc_path=None, obj_path=None, name='Scan2BIM AI', ifc_schema='IFC4'):
    out = {}
    if ifc_path:
        write_ifc(model, ifc_path, name=name, schema=ifc_schema)
        out['ifc'] = ifc_path
    if obj_path:
        _obj_from_model(model, obj_path)
        out['obj'] = obj_path
    return out
