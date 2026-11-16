# -*- coding: utf-8 -*-
"""mesh-tools.py — P2: инструменты работы с mesh для приложения BIM Twin.

Операции (в порядке применения):
  --fill-holes [--max-hole-edges N]      заполнение дыр по граничным петлям (fan-триангуляция);
  --smooth ITER [--lambda 0.5]           лапласово сглаживание с сохранением границы
                                         (граничные вершины не двигаются);
  --remove-triangles SPEC                удаление треугольников:
                                           color:R,G,B[,tol]  — по цвету (vertex colors);
                                           class:R,G,B[,tol]  — по «классу» (тот же цвет → класс);
                                           volume:MIN_M3      — мелкие компоненты объёмом < MIN;
  --decimate SPEC                        упрощение: quadric:N (до N треугольников, Open3D)
                                         или voxel:SIZE (vertex clustering, шаг м).

Вход/выход: PLY / OBJ / GLB / STL (Open3D). JSON-отчёт: --json.
Запуск:
  python tools/scan2bim-py/mesh-tools.py --in mesh.ply --out mesh-out.ply \
         --fill-holes --smooth 5 --remove-triangles color:255,0,0,30 \
         --decimate quadric:200000 --json mesh-report.json
Коды: 0 — успех, 2 — ошибка входа/аргументов.
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np

try:
    import open3d as o3d
except Exception:  # pragma: no cover
    o3d = None


# ======================= mesh helpers =======================
def mesh_edges(T):
    """Уникальные неориентированные рёбра (M1,2) и их количество."""
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]], axis=0)
    e = np.sort(e, axis=1)
    uniq, inv, cnt = np.unique(e, axis=0, return_inverse=True, return_counts=True)
    return uniq, cnt, inv.reshape(-1)


def boundary_edges(T):
    """Рёбра, встречающиеся ровно один раз (граница), и число треугольников."""
    uniq, cnt, _ = mesh_edges(T)
    return uniq[cnt == 1]


def boundary_loops(T, max_edges=2000):
    """Петли граничных рёбер (списки вершин в порядке обхода)."""
    be = boundary_edges(T)
    if len(be) == 0:
        return []
    adj = {}
    for a, b in be:
        adj.setdefault(int(a), set()).add(int(b))
        adj.setdefault(int(b), set()).add(int(a))
    loops = []
    visited = set()
    for start in list(adj.keys()):
        if start in visited:
            continue
        # проход по петле
        loop = [start]
        visited.add(start)
        prev = None
        cur = start
        ok = False
        while True:
            nxts = [n for n in adj.get(cur, ()) if n != prev]
            nxts = [n for n in nxts if n not in visited or n == start]
            if not nxts:
                break
            nxt = nxts[0]
            if nxt == start:
                ok = True
                break
            loop.append(nxt)
            visited.add(nxt)
            prev, cur = cur, nxt
            if len(loop) > max_edges:
                break
        if ok and len(loop) >= 3:
            loops.append(loop)
    return loops


def fill_holes(mesh, max_edges=500):
    """Заполняет дыры с границей ≤ max_edges рёбер fan-триангуляцией. → число дыр/треуг."""
    V = np.asarray(mesh.vertices, dtype=np.float64)
    T = np.asarray(mesh.triangles, dtype=np.int64)
    if len(T) == 0:
        return 0, 0
    loops = [lp for lp in boundary_loops(T) if len(lp) <= max_edges]
    filled = 0
    new_tris = []
    extra_verts = []
    for lp in loops:
        pts = V[lp]
        c = pts.mean(axis=0)
        ci = len(V) + len(extra_verts)
        extra_verts.append(c)
        for i in range(len(lp)):
            a, b = lp[i], lp[(i + 1) % len(lp)]
            new_tris.append([a, b, ci])
        filled += 1
    if filled:
        V2 = np.vstack([V, np.array(extra_verts)]) if extra_verts else V
        T2 = np.vstack([T, np.array(new_tris, dtype=np.int64)]) if new_tris else T
        mesh.vertices = o3d.utility.Vector3dVector(V2)
        mesh.triangles = o3d.utility.Vector3iVector(T2)
        # цвета для новых вершин (усреднённые)
        vc = np.asarray(mesh.vertex_colors)
        if len(vc) > 0:
            vc2 = np.vstack([vc[:len(V)],
                             np.tile(np.median(vc[:len(V)], axis=0), (len(extra_verts), 1))]) \
                if extra_verts else vc
            mesh.vertex_colors = o3d.utility.Vector3dVector(vc2)
    return filled, len(new_tris)


def laplacian_smooth(mesh, iterations=5, lam=0.5, preserve_boundary=True):
    """Лапласово сглаживание (граничные вершины фиксированы). → (движение max, вершины)."""
    V = np.asarray(mesh.vertices, dtype=np.float64).copy()
    T = np.asarray(mesh.triangles, dtype=np.int64)
    if len(T) == 0:
        return 0.0, len(V)
    # рёбра
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]], axis=0)
    eu = np.sort(e, axis=1)
    uniq, cnt = np.unique(eu, axis=0, return_counts=True)
    be = uniq[cnt == 1]
    boundary_v = np.zeros(len(V), bool)
    if preserve_boundary and len(be):
        boundary_v[np.unique(be.ravel())] = True
    # степени и списки соседей через рёбра (в обе стороны)
    a = np.concatenate([e[:, 0], e[:, 1]])
    b = np.concatenate([e[:, 1], e[:, 0]])
    deg = np.bincount(a, minlength=len(V)).astype(np.float64)
    free = ~boundary_v
    max_move = 0.0
    for _ in range(int(iterations)):
        # среднее по соседям
        acc = np.zeros_like(V)
        np.add.at(acc, a, V[b])
        mean = acc / np.maximum(deg[:, None], 1.0)
        delta = (mean - V) * lam
        delta[~free] = 0.0
        V[free] += delta[free]
        max_move = max(max_move, float(np.linalg.norm(delta[free], axis=1).max()) if free.any() else 0.0)
    mesh.vertices = o3d.utility.Vector3dVector(V)
    return max_move, int(free.sum())


def triangle_volume(V, T):
    """Суммарный объём замкнутого mesh (по знаковым тетраэдрам)."""
    if len(T) == 0:
        return 0.0
    p0 = V[T[:, 0]]; p1 = V[T[:, 1]]; p2 = V[T[:, 2]]
    vols = np.einsum('ij,ij->i', p0, np.cross(p1, p2)) / 6.0
    return float(abs(vols.sum()))


def remove_by_color(mesh, color, tol=30.0):
    """Удаляет треугольники, средний цвет вершин которых близок к color (0-255)."""
    V = np.asarray(mesh.vertices)
    T = np.asarray(mesh.triangles)
    vc = np.asarray(mesh.vertex_colors)
    if len(vc) == 0 or len(T) == 0:
        return 0, int(len(T))
    C = np.array(color, dtype=np.float64)
    if C.max() > 1.5:
        C = C / 255.0
    tri_col = vc[T].mean(axis=1)
    d = np.linalg.norm(tri_col - C[None, :], axis=1)
    keep = d > (tol / 255.0)
    mesh.triangles = o3d.utility.Vector3iVector(T[keep])
    if len(vc) == len(V):
        # убираем неиспользуемые вершины
        mesh.remove_unreferenced_vertices()
    return int((~keep).sum()), int(keep.sum())


def remove_small_components(mesh, min_volume=0.01):
    """Удаляет компоненты связности объёмом < min_volume (мусор/обломки). → удалено компонент."""
    T = np.asarray(mesh.triangles)
    V = np.asarray(mesh.vertices)
    if len(T) == 0:
        return 0
    labels, counts, tri_labels = mesh.cluster_connected_triangles()
    labels = np.asarray(labels)
    removed = 0
    keep_mask = np.ones(len(T), bool)
    for lab in np.unique(labels):
        sel = np.where(labels == lab)[0]
        if len(sel) == 0:
            continue
        vvol = triangle_volume(V, T[sel])
        if vvol < min_volume:
            keep_mask[sel] = False
            removed += 1
    if removed:
        mesh.triangles = o3d.utility.Vector3iVector(T[keep_mask])
        mesh.remove_unreferenced_vertices()
    return removed


def decimate_quadric(mesh, target_triangles):
    if len(np.asarray(mesh.triangles)) == 0:
        return 0
    out = mesh.simplify_quadric_decimation(int(target_triangles))
    mesh.vertices = out.vertices
    mesh.triangles = out.triangles
    if len(np.asarray(out.vertex_colors)):
        mesh.vertex_colors = out.vertex_colors
    if len(np.asarray(out.vertex_normals)):
        mesh.vertex_normals = out.vertex_normals
    return int(len(np.asarray(mesh.triangles)))


def decimate_voxel(mesh, voxel_size):
    if len(np.asarray(mesh.triangles)) == 0:
        return 0
    out = mesh.simplify_vertex_clustering(voxel_size=float(voxel_size))
    mesh.vertices = out.vertices
    mesh.triangles = out.triangles
    return int(len(np.asarray(mesh.triangles)))


# ======================= IO =======================
def load_mesh(path):
    if o3d is None:
        raise RuntimeError('нужен open3d')
    m = o3d.io.read_triangle_mesh(path, enable_post_processing=False)
    if len(np.asarray(m.triangles)) == 0:
        # попытка как point cloud → не mesh
        raise ValueError('в файле нет треугольников (это облако/точки?)')
    return m


def save_mesh(mesh, path):
    ok = o3d.io.write_triangle_mesh(path, mesh, write_ascii=False)
    if not ok:
        raise RuntimeError('не удалось записать %s' % path)


def mesh_summary(mesh):
    V = np.asarray(mesh.vertices)
    T = np.asarray(mesh.triangles)
    be = boundary_edges(T) if len(T) else np.zeros((0, 2))
    s = {'vertices': int(len(V)), 'triangles': int(len(T)),
         'boundary_edges': int(len(be)), 'watertight': bool(len(be) == 0),
         'bbox': [float(V[:, 0].min()), float(V[:, 1].min()), float(V[:, 2].min()),
                  float(V[:, 0].max()), float(V[:, 1].max()), float(V[:, 2].max())] if len(V) else None}
    s['volume_m3'] = round(triangle_volume(V, T), 6) if len(T) else 0.0
    return s


# ======================= main =======================
def main(argv=None):
    ap = argparse.ArgumentParser(description='Mesh-инструменты: дыры, сглаживание, удаление, упрощение')
    ap.add_argument('--in', dest='inp', required=True, help='PLY/OBJ/GLB/STL mesh')
    ap.add_argument('--out', required=True, help='выходной mesh (PLY/OBJ/GLB/STL)')
    ap.add_argument('--fill-holes', action='store_true')
    ap.add_argument('--max-hole-edges', type=int, default=500)
    ap.add_argument('--smooth', type=int, default=0, metavar='ITER')
    ap.add_argument('--lambda', dest='lam', type=float, default=0.5)
    ap.add_argument('--remove-triangles', default=None, metavar='SPEC',
                    help='color:R,G,B[,tol] | class:R,G,B[,tol] | volume:MIN_M3')
    ap.add_argument('--decimate', default=None, metavar='SPEC',
                    help='quadric:N_TRIANGLES | voxel:SIZE_M')
    ap.add_argument('--json', default=None)
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args(argv)
    t0 = time.time()
    rep = {'schema': 'mesh-tools/1', 'ok': False, 'in': a.inp, 'out': a.out,
           'generated': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'operations': []}
    try:
        mesh = load_mesh(a.inp)
        rep['before'] = mesh_summary(mesh)
    except Exception as e:  # noqa: BLE001
        print('ОШИБКА входа: %s' % e, file=sys.stderr)
        rep['error'] = str(e)
        if a.json:
            json.dump(rep, open(a.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        return 2
    t_before = time.time()
    try:
        if a.fill_holes:
            t = time.time()
            holes, added = fill_holes(mesh, a.max_hole_edges)
            rep['operations'].append({'op': 'fill-holes', 'holes_filled': holes,
                                      'triangles_added': added,
                                      'seconds': round(time.time() - t, 3)})
        if a.smooth > 0:
            t = time.time()
            move, nfree = laplacian_smooth(mesh, a.smooth, a.lam, True)
            rep['operations'].append({'op': 'smooth', 'iterations': a.smooth,
                                      'lambda': a.lam, 'moved_vertices': nfree,
                                      'max_move_m': round(move, 6),
                                      'seconds': round(time.time() - t, 3)})
        if a.remove_triangles:
            spec = a.remove_triangles.strip()
            t = time.time()
            if spec.startswith('volume:'):
                minv = float(spec.split(':', 1)[1])
                removed_comp = remove_small_components(mesh, minv)
                rep['operations'].append({'op': 'remove-triangles', 'by': 'volume',
                                          'min_volume_m3': minv,
                                          'components_removed': removed_comp,
                                          'seconds': round(time.time() - t, 3)})
            elif spec.startswith(('color:', 'class:')):
                body = spec.split(':', 1)[1]
                vals = [float(x) for x in body.split(',')]
                if len(vals) < 3:
                    raise ValueError('цвет: R,G,B[,tol]')
                tol = vals[3] if len(vals) > 3 else 30.0
                removed, kept = remove_by_color(mesh, vals[:3], tol)
                rep['operations'].append({'op': 'remove-triangles',
                                          'by': spec.split(':', 1)[0],
                                          'color': vals[:3], 'tolerance': tol,
                                          'triangles_removed': removed,
                                          'triangles_left': kept,
                                          'seconds': round(time.time() - t, 3)})
            else:
                raise ValueError('--remove-triangles: color:... | class:... | volume:...')
        if a.decimate:
            spec = a.decimate.strip()
            t = time.time()
            if spec.startswith('quadric:'):
                target = int(spec.split(':', 1)[1])
                n2 = decimate_quadric(mesh, target)
                rep['operations'].append({'op': 'decimate', 'method': 'quadric',
                                          'target_triangles': target,
                                          'triangles_after': n2,
                                          'seconds': round(time.time() - t, 3)})
            elif spec.startswith('voxel:'):
                vs = float(spec.split(':', 1)[1])
                n2 = decimate_voxel(mesh, vs)
                rep['operations'].append({'op': 'decimate', 'method': 'voxel',
                                          'voxel_m': vs, 'triangles_after': n2,
                                          'seconds': round(time.time() - t, 3)})
            else:
                raise ValueError('--decimate: quadric:N | voxel:SIZE')
        save_mesh(mesh, a.out)
        rep['after'] = mesh_summary(mesh)
        rep['seconds_total'] = round(time.time() - t0, 2)
        rep['ok'] = True
    except Exception as e:  # noqa: BLE001
        print('ОШИБКА операции: %s' % e, file=sys.stderr)
        rep['error'] = str(e)
        if a.json:
            json.dump(rep, open(a.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        return 2
    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)) or '.', exist_ok=True)
        json.dump(rep, open(a.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if not a.quiet:
        b, af = rep['before'], rep['after']
        print('=== mesh-tools: %s → %s ===' % (os.path.basename(a.inp), os.path.basename(a.out)))
        print('до:    %d вершин, %d треугольников, boundary %d, объём %.4f м³' % (
            b['vertices'], b['triangles'], b['boundary_edges'], b['volume_m3']))
        for op in rep['operations']:
            print('  %s: %s (%.2f с)' % (op['op'], json.dumps(
                {k: v for k, v in op.items() if k not in ('op', 'seconds')}, ensure_ascii=False),
                op['seconds']))
        print('после: %d вершин, %d треугольников, boundary %d, watertight %s, объём %.4f м³' % (
            af['vertices'], af['triangles'], af['boundary_edges'], af['watertight'], af['volume_m3']))
        print('время: %.2f с' % rep['seconds_total'])
        if a.json:
            print('JSON:', os.path.abspath(a.json))
    return 0


if __name__ == '__main__':
    sys.exit(main())
