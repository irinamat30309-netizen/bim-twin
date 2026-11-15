# -*- coding: utf-8 -*-
"""georef-rtk.py — привязка облака Lixel к реальным координатам по RTK-данным (вариант A).

Один запуск, когда заказчик принесёт RTK-скан:
  1) читает project_data/gnss.csv и project_data/poses.csv;
  2) берёт только строки GNSS с fix/RTK fixed (status=fix или числовой 3D-fix и лучше);
  3) интерполирует GNSS на времена поз;
  4) lat/lon/alt → ECEF → геодезические → UTM (формулы WGS84/ETRS89, без внешних библиотек);
  5) подбирает 4-параметрическую (поворот+масштаб+сдвиг) или 7-параметрическую (3D Helmert)
     трансформацию локальных поз → UTM по >=3 общим точкам;
  6) пишет georef.json: rotation_deg, translation, scale, невязки rms/max по точкам,
     bbox облака в UTM, EPSG, готовые значения для IfcMapConversion;
  7) печатает таблицу.  --strict: exit 1, если невзяка >0.15 м или общих точек <3.

Коды возврата: 0 — успех; 2 — нет данных fix / общих точек <3; 1 — --strict не выполнен,
ошибка входных данных.

Кадры (--local-plan):
  xy  (по умолчанию) — Lixel poses.csv: x,y — план, z — вверх (кадр скана/LAS);
  xz  — модель/облако нашего конвейера (las-to-bin.js): x,z — план, y — вверх.
      С --from-las-origin "ox,oy,oz" (origin из las-to-bin.js) локальные координаты считаются
      кадром модели и переводятся в кадр скана: X=x+ox, Y=oy-z, Z=y+oz; для IFC выдаётся
      sourceTransform {axis:"zup"} (зеркалит план) и реальный IfcMapConversion.

Система координат: зона UTM зависит от долготы. Для Киева (30.5° в.д.) — 36N
(центральный меридиан 33°), EPSG:32636 (WGS84) или 25836 (ETRS89). EPSG:25833 — зона 33N
(CM 15°E, покрытие 12–18°E), для Киева неприменима; при явном указании будет предупреждение.

Запуск:
  python tools/scan2bim-py/georef-rtk.py --project <папка Lixel> --out georef.json --strict
  python tools/scan2bim-py/georef-rtk.py --project <папка> --local-plan xz --from-las-origin ox,oy,oz
"""
import argparse
import json
import math
import os
import sys
import time

# ----------------------------- WGS84 / ETRS89 -----------------------------
WGS84_A = 6378137.0
WGS84_F = 1.0 / 298.257223563
GRS80_A = 6378137.0
GRS80_F = 1.0 / 298.257222101

CRS_NAMES = {'wgs84': 'WGS 84 / UTM zone {zone}{hemi}',
             'etrs89': 'ETRS89 / UTM zone {zone}{hemi}'}


def norm_deg(lon):
    while lon > 180.0:
        lon -= 360.0
    while lon <= -180.0:
        lon += 360.0
    return lon


def utm_zone_of(lon):
    z = int(math.floor((norm_deg(lon) + 180.0) / 6.0)) + 1
    return max(1, min(60, z))


def central_meridian(zone):
    return zone * 6.0 - 183.0


def tm_forward(lat_deg, lon_deg, a, f, lat0_deg, lon0_deg, k0, fe, fn):
    """Прямая проекция Transverse Mercator (серия Снайдера до e^6). → (E, N)."""
    e2 = f * (2.0 - f)
    ep2 = e2 / (1.0 - e2)
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg - lon0_deg)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    tan_lat = math.tan(lat)
    if abs(cos_lat) < 1e-12:
        raise ValueError('TM: полюс')
    N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    T = tan_lat * tan_lat
    C = ep2 * cos_lat * cos_lat
    A = cos_lat * lon
    e4, e6 = e2 * e2, e2 * e2 * e2
    m_ = a * ((1.0 - e2 / 4.0 - 3.0 * e4 / 64.0 - 5.0 * e6 / 256.0) * lat
              - (3.0 * e2 / 8.0 + 3.0 * e4 / 32.0 + 45.0 * e6 / 1024.0) * math.sin(2.0 * lat)
              + (15.0 * e4 / 256.0 + 45.0 * e6 / 1024.0) * math.sin(4.0 * lat)
              - (35.0 * e6 / 3072.0) * math.sin(6.0 * lat))
    lat0 = math.radians(lat0_deg)
    m0 = a * ((1.0 - e2 / 4.0 - 3.0 * e4 / 64.0 - 5.0 * e6 / 256.0) * lat0
              - (3.0 * e2 / 8.0 + 3.0 * e4 / 32.0 + 45.0 * e6 / 1024.0) * math.sin(2.0 * lat0)
              + (15.0 * e4 / 256.0 + 45.0 * e6 / 1024.0) * math.sin(4.0 * lat0)
              - (35.0 * e6 / 3072.0) * math.sin(6.0 * lat0))
    x = k0 * N * (A + (1.0 - T + C) * A ** 3 / 6.0
                  + (5.0 - 18.0 * T + T * T + 72.0 * C - 58.0 * ep2) * A ** 5 / 120.0)
    y = k0 * (m_ - m0 + N * tan_lat * (A * A / 2.0
                                       + (5.0 - T + 9.0 * C + 4.0 * C * C) * A ** 4 / 24.0
                                       + (61.0 - 58.0 * T + T * T + 600.0 * C - 330.0 * ep2) * A ** 6 / 720.0))
    return fe + x, fn + y


def tm_inverse(easting, northing, a, f, lat0_deg, lon0_deg, k0, fe, fn):
    """Обратная проекция Transverse Mercator → (lat_deg, lon_deg)."""
    e2 = f * (2.0 - f)
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))
    e4, e6 = e2 * e2, e2 * e2 * e2
    x = easting - fe
    y = northing - fn
    M = y / k0
    mu = M / (a * (1.0 - e2 / 4.0 - 3.0 * e4 / 64.0 - 5.0 * e6 / 256.0))
    phi1 = (mu + (3.0 * e1 / 2.0 - 27.0 * e1 ** 3 / 32.0) * math.sin(2.0 * mu)
            + (21.0 * e1 * e1 / 16.0 - 55.0 * e1 ** 4 / 32.0) * math.sin(4.0 * mu)
            + (151.0 * e1 ** 3 / 96.0) * math.sin(6.0 * mu))
    sinphi = math.sin(phi1)
    cosphi = math.cos(phi1)
    tanphi = math.tan(phi1)
    if abs(cosphi) < 1e-12:
        raise ValueError('TM inverse: полюс')
    N1 = a / math.sqrt(1.0 - e2 * sinphi * sinphi)
    T1 = tanphi * tanphi
    C1 = e2 / (1.0 - e2) * cosphi * cosphi
    R1 = a * (1.0 - e2) / (1.0 - e2 * sinphi * sinphi) ** 1.5
    D = x / (N1 * k0)
    lat = phi1 - (N1 * tanphi / R1) * (
        D * D / 2.0 - (5.0 + 3.0 * T1 + 10.0 * C1 - 4.0 * C1 * C1 - 9.0 * e2) * D ** 4 / 24.0
        + (61.0 + 90.0 * T1 + 298.0 * C1 + 45.0 * T1 * T1 - 252.0 * e2 - 3.0 * C1 * C1) * D ** 6 / 720.0)
    lon = (D - (1.0 + 2.0 * T1 + C1) * D ** 3 / 6.0
           + (5.0 - 2.0 * C1 + 28.0 * T1 - 3.0 * C1 * C1 + 8.0 * e2 + 24.0 * T1 * T1) * D ** 5 / 120.0) / cosphi
    return math.degrees(lat), norm_deg(lon0_deg + math.degrees(lon))


def utm_forward(lat_deg, lon_deg, zone=None, datum='wgs84'):
    if zone is None:
        zone = utm_zone_of(lon_deg)
    a, f = (WGS84_A, WGS84_F) if datum == 'wgs84' else (GRS80_A, GRS80_F)
    return tm_forward(lat_deg, lon_deg, a, f, 0.0, central_meridian(zone), 0.9996, 500000.0, 0.0)


def utm_inverse(easting, northing, zone, datum='wgs84'):
    a, f = (WGS84_A, WGS84_F) if datum == 'wgs84' else (GRS80_A, GRS80_F)
    return tm_inverse(easting, northing, a, f, 0.0, central_meridian(zone), 0.9996, 500000.0, 0.0)


def latlon_to_ecef(lat_deg, lon_deg, h, datum='wgs84'):
    a, f = (WGS84_A, WGS84_F) if datum == 'wgs84' else (GRS80_A, GRS80_F)
    e2 = f * (2.0 - f)
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    return ((N + h) * cos_lat * math.cos(lon), (N + h) * cos_lat * math.sin(lon),
            (N * (1.0 - e2) + h) * sin_lat)


def ecef_to_latlon(x, y, z, datum='wgs84'):
    a, f = (WGS84_A, WGS84_F) if datum == 'wgs84' else (GRS80_A, GRS80_F)
    e2 = f * (2.0 - f)
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1.0 - e2))
    for _ in range(12):
        sin_lat = math.sin(lat)
        N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
        h = p / math.cos(lat) - N
        lat_new = math.atan2(z, p * (1.0 - e2 * N / (N + h)))
        if abs(lat_new - lat) < 1e-14:
            lat = lat_new
            break
        lat = lat_new
    sin_lat = math.sin(lat)
    N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    h = p / math.cos(lat) - N
    return math.degrees(lat), norm_deg(math.degrees(lon)), h


# ----------------------------- CRS / WKT -----------------------------
def epsg_for(zone, datum='wgs84'):
    return (32600 + zone) if datum == 'wgs84' else (25800 + zone)


def datum_of_epsg(epsg):
    try:
        epsg = int(epsg)
    except (TypeError, ValueError):
        return None, None, None
    if 32601 <= epsg <= 32660:
        return (epsg - 32600), 'wgs84', 'N'
    if 32701 <= epsg <= 32760:
        return (epsg - 32700), 'wgs84', 'S'
    if 25801 <= epsg <= 25860:
        return (epsg - 25800), 'etrs89', 'N'
    return None, None, None


def wkt_utm(zone, datum='wgs84', hemisphere='N'):
    """WKT2 для IfcProjectedCRS (UTM), EPSG-код последним."""
    if datum == 'wgs84':
        crs_name = 'WGS 84 / UTM zone %d%s' % (zone, hemisphere)
        geog_name = 'WGS 84'
        datum_name = 'World Geodetic System 1984'
        ell_name, a, rf = 'WGS 84', 6378137.0, 298.257223563
        epsg = (32600 + zone) if hemisphere == 'N' else (32700 + zone)
    else:
        crs_name = 'ETRS89 / UTM zone %d%s' % (zone, hemisphere)
        geog_name = 'ETRS89'
        datum_name = 'European Terrestrial Reference System 1989'
        ell_name, a, rf = 'GRS 1980', 6378137.0, 298.257222101
        epsg = 25800 + zone
    lon0 = central_meridian(zone)
    fn = 10000000 if hemisphere == 'S' else 0
    lon0_s = ('%d' % lon0) if abs(lon0 - round(lon0)) < 1e-9 else ('%g' % lon0)
    return ('PROJCRS["%s",BASEGEOGCRS["%s",DATUM["%s",ELLIPSOID["%s",%s,%s,LENGTHUNIT["metre",1]]],'
            'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]]],'
            'CONVERSION["UTM zone %d%s",METHOD["Transverse Mercator",ID["EPSG",9807]],'
            'PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],'
            'PARAMETER["Longitude of natural origin",%s,ANGLEUNIT["degree",0.0174532925199433]],'
            'PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],'
            'PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],'
            'PARAMETER["False northing",%d,LENGTHUNIT["metre",1]]],'
            'CS[Cartesian,2],AXIS["easting (E)",east,ORDER[1],LENGTHUNIT["metre",1]],'
            'AXIS["northing (N)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",%d]]'
            % (crs_name, geog_name, datum_name, ell_name, a, rf, zone, hemisphere, lon0_s, fn, epsg))


# ----------------------------- чтение CSV -----------------------------
def read_csv_rows(path):
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    rows, header = [], None
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith('#'):
                if header is None and 'timestamp' in line:
                    header = [c.strip() for c in line.lstrip('#').split(',')]
                continue
            rows.append([p.strip() for p in line.split(',')])
    return rows, header


def is_fix_status(status, gnss_type, accepted):
    s = (status or '').strip().lower()
    g = (gnss_type or '').strip().lower()
    if 'float' in s:
        return False
    if accepted and accepted != ['auto']:
        for a in accepted:
            a = a.strip().lower()
            if a and (a == s or a in s or (g and a in g)):
                return True
        return False
    for k in ('rtk fixed', 'rtk_fix', 'rtk-fix', 'fixed', 'fix'):
        if k in s:
            return True
    if 'rtk' in g and s not in ('', '0', '1', '2'):
        return True
    try:
        v = int(float(s))
    except (TypeError, ValueError):
        return False
    return v >= 3


def parse_gnss(path, accepted):
    rows, header = read_csv_rows(path)
    hdr = header or ['timestamp', 'status', 'latitude', 'longitude', 'altitude',
                     'gnss_type', 'undulation', 'pdop', 'hdop', 'vdop']
    idx = {n: i for i, n in enumerate(hdr)}
    out, rejected = [], 0
    for r in rows:
        if len(r) < 5:
            continue
        try:
            ts = float(r[0])
            lat = float(r[idx.get('latitude', 2)])
            lon = float(r[idx.get('longitude', 3)])
            ai = idx.get('altitude', 4)
            alt = float(r[ai]) if len(r) > ai and r[ai] != '' else float('nan')
        except (ValueError, IndexError):
            continue
        si = idx.get('status', 1)
        gi = idx.get('gnss_type', 5)
        status = r[si] if len(r) > si else ''
        gtype = r[gi] if len(r) > gi else ''
        und = None
        ui = idx.get('undulation', 6)
        if len(r) > ui and r[ui] not in ('', 'nan'):
            try:
                und = float(r[ui])
            except ValueError:
                und = None
        if not is_fix_status(status, gtype, accepted):
            rejected += 1
            continue
        if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
            rejected += 1
            continue
        out.append({'t': ts, 'status': status, 'gnss_type': gtype, 'lat': lat, 'lon': lon,
                    'alt': alt, 'undulation': und})
    return out, rejected, len(rows), hdr


def parse_poses(path):
    rows, header = read_csv_rows(path)
    out = []
    for r in rows:
        if len(r) < 4:
            continue
        try:
            ts = float(r[0]); x = float(r[1]); y = float(r[2]); z = float(r[3])
        except (ValueError, IndexError):
            continue
        q = [0.0, 0.0, 0.0, 1.0]
        if len(r) >= 8:
            try:
                q = [float(r[4]), float(r[5]), float(r[6]), float(r[7])]
            except ValueError:
                pass
        out.append({'t': ts, 'x': x, 'y': y, 'z': z, 'q': q})
    return out, header


# ----------------------------- интерполяция -----------------------------
def interpolate_gnss(poses, fixes, max_gap=2.0, height_mode='ellipsoidal'):
    if not fixes or not poses:
        return [], {'matched': 0, 'span_s': 0.0}
    fixes = sorted(fixes, key=lambda d: d['t'])
    poses = sorted(poses, key=lambda d: d['t'])
    ts = [f['t'] for f in fixes]
    pairs = []
    for p in poses:
        t = p['t']
        if t < ts[0] - max_gap or t > ts[-1] + max_gap:
            continue
        lo, hi = 0, len(ts)
        while lo < hi:
            mid = (lo + hi) // 2
            if ts[mid] < t:
                lo = mid + 1
            else:
                hi = mid
        if lo < len(ts) and abs(ts[lo] - t) <= 1e-9:
            g = dict(fixes[lo])
        elif lo == 0:
            if ts[0] - t > max_gap:
                continue
            g = dict(fixes[0])
        elif lo >= len(ts):
            if t - ts[-1] > max_gap:
                continue
            g = dict(fixes[-1])
        else:
            a, b = fixes[lo - 1], fixes[lo]
            da, db = t - a['t'], b['t'] - t
            if da <= max_gap and db <= max_gap:
                f = da / (b['t'] - a['t'])
                g = {'t': t, 'lat': a['lat'] + (b['lat'] - a['lat']) * f,
                     'lon': a['lon'] + (b['lon'] - a['lon']) * f,
                     'alt': a['alt'] + (b['alt'] - a['alt']) * f,
                     'undulation': a.get('undulation')}
            elif da <= max_gap:
                g = dict(a)
            elif db <= max_gap:
                g = dict(b)
            else:
                continue
        alt = g['alt']
        if height_mode == 'orthometric' and g.get('undulation') is not None and math.isfinite(alt):
            alt = alt + g['undulation']
        pairs.append({'pose': p, 'lat': g['lat'], 'lon': g['lon'], 'alt': alt})
    return pairs, {'matched': len(pairs), 'span_s': ts[-1] - ts[0] if len(ts) > 1 else 0.0}


# ----------------------------- трансформации -----------------------------
def fit_4param(points, use_scale=True):
    """4-параметрическая трансформация (X,Y)→(E,N) через комплексные числа."""
    ps = [complex(p['X'], p['Y']) for p in points]
    qs = [complex(p['E'], p['N']) for p in points]
    n = len(ps)
    if n < 2:
        raise ValueError('нужно >=2 точек для 4-параметрической')
    pm = sum(ps) / n
    qm = sum(qs) / n
    num = sum((p - pm).conjugate() * (q - qm) for p, q in zip(ps, qs))
    den = sum(abs(p - pm) ** 2 for p in ps)
    if abs(den) < 1e-9:
        raise ValueError('локальные точки вырождены (нельзя оценить поворот)')
    a = num / den
    if not use_scale:
        th = math.atan2(a.imag, a.real)
        a = complex(math.cos(th), math.sin(th))
    b = qm - a * pm
    rot = math.degrees(math.atan2(a.imag, a.real))
    scale = abs(a)
    res = []
    for p, q in zip(ps, qs):
        pred = a * p + b
        res.append({'local_x': p.real, 'local_y': p.imag, 'utm_e': q.real, 'utm_n': q.imag,
                    'pred_e': pred.real, 'pred_n': pred.imag, 'd2d': abs(pred - q)})
    rms = math.sqrt(sum(r['d2d'] ** 2 for r in res) / n)
    return {'mode': 4, 'rotation_deg': rot, 'scale': scale,
            'translation': [b.real, b.imag], 'residuals': res,
            'rms_2d': rms, 'max_2d': max(r['d2d'] for r in res), 'n_points': n}


def fit_7param(points):
    """7-параметрическая 3D Helmert (Kabsch): (X,Y,Z)→(E,N,H)."""
    import numpy as np
    P = np.array([[p['X'], p['Y'], p['Z']] for p in points], dtype=float)
    Q = np.array([[p['E'], p['N'], p['H']] for p in points], dtype=float)
    n = len(P)
    if n < 3:
        raise ValueError('нужно >=3 точек для 7-параметрической')
    Pm = P.mean(axis=0); Qm = Q.mean(axis=0)
    Pc = P - Pm; Qc = Q - Qm
    H = Pc.T @ Qc
    U, S, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    R = Vt.T @ D @ U.T
    scale = float((S @ np.array([1.0, 1.0, d])) / (Pc ** 2).sum())
    t = Qm - scale * (R @ Pm)
    pred = (scale * (R @ P.T)).T + t
    d3 = np.linalg.norm(pred - Q, axis=1)
    d2 = np.linalg.norm(pred[:, :2] - Q[:, :2], axis=1)
    sy = max(-1.0, min(1.0, -R[2, 0]))
    ry = math.asin(sy)
    rx = math.atan2(R[2, 1], R[2, 2])
    rz = math.atan2(R[1, 0], R[0, 0])
    res = []
    for i in range(n):
        res.append({'local_x': P[i, 0], 'local_y': P[i, 1], 'local_z': P[i, 2],
                    'utm_e': Q[i, 0], 'utm_n': Q[i, 1], 'utm_h': Q[i, 2],
                    'pred_e': pred[i, 0], 'pred_n': pred[i, 1], 'pred_h': pred[i, 2],
                    'd2d': float(d2[i]), 'd3d': float(d3[i])})
    return {'mode': 7, 'rotation_deg': math.degrees(rz),
            'euler_deg': [math.degrees(rx), math.degrees(ry), math.degrees(rz)],
            'scale': scale, 'translation': [float(v) for v in t], 'R': R.tolist(),
            'residuals': res, 'rms_2d': float(math.sqrt(np.mean(d2 ** 2))),
            'max_2d': float(d2.max()), 'rms_3d': float(math.sqrt(np.mean(d3 ** 2))),
            'max_3d': float(d3.max()), 'n_points': n}


def fit_height(points, fit_scale=False):
    """H = tz + sz*Z (МНК по 1D). Масштаб sz по умолчанию 1 (RTK и SLAM метрические);
    оценивать sz имеет смысл только при большом разбросе Z (>1 м) и явном флаге fit_scale."""
    n = len(points)
    zm = sum(p['Z'] for p in points) / n
    hm = sum(p['H'] for p in points) / n
    den = sum((p['Z'] - zm) ** 2 for p in points) / n
    sz = 1.0
    if fit_scale and den > 1.0:
        sz = sum((p['H'] - hm) * (p['Z'] - zm) for p in points) / (den * n)
    tz = hm - sz * zm
    return sz, tz


# ----------------------------- bbox -----------------------------
def read_las_bbox(path):
    try:
        with open(path, 'rb') as f:
            head = f.read(375)
        if head[:4] != b'LASF':
            return None
        import struct
        maxx, minx, maxy, miny, maxz, minz = struct.unpack('<6d', head[179:227])
        return (minx, maxx, miny, maxy, minz, maxz)
    except Exception:
        return None


def find_las(project_dir):
    import glob
    cands = []
    for d in (project_dir, os.path.dirname(project_dir.rstrip('\\/')),
              os.path.join(project_dir, 'model')):
        if d and os.path.isdir(d):
            for pat in ('*.las', '*.laz'):
                cands += glob.glob(os.path.join(d, pat))
    cands = [c for c in cands if os.path.isfile(c)]
    return sorted(cands, key=lambda c: -os.path.getsize(c))[0] if cands else None


def bbox_utm(points, transform, extra_local=None):
    """bbox в UTM по локальным X,Y,Z (по позам; extra — углы LAS-заголовка)."""
    if extra_local:
        xs = [c[0] for c in extra_local]; ys = [c[1] for c in extra_local]; zs = [c[2] for c in extra_local]
    else:
        xs = [p['X'] for p in points]; ys = [p['Y'] for p in points]; zs = [p['Z'] for p in points]
    es, ns, hs = [], [], []
    for x, y, z in ((min(xs), min(ys), min(zs)), (min(xs), max(ys), min(zs)),
                    (max(xs), min(ys), min(zs)), (max(xs), max(ys), min(zs)),
                    (min(xs), min(ys), max(zs)), (min(xs), max(ys), max(zs)),
                    (max(xs), min(ys), max(zs)), (max(xs), max(ys), max(zs))):
        es_, ns_, hs_ = transform_point(transform, x, y, z)
        es.append(es_); ns.append(ns_); hs.append(hs_)
    return {'min': [min(es), min(ns), min(hs)], 'max': [max(es), max(ns), max(hs)]}


def transform_point(tr, x, y, z):
    if tr['mode'] == 7:
        import numpy as np
        R = np.array(tr['R']); s = tr['scale']; t = tr['translation']
        q = s * (R @ np.array([x, y, z])) + t
        return float(q[0]), float(q[1]), float(q[2])
    rot = math.radians(tr['rotation_deg'])
    s = tr['scale']; tx, ty = tr['translation'][:2]
    sz, tz = tr.get('z_scale', 1.0), tr.get('translation_z', 0.0)
    ca, sa = math.cos(rot), math.sin(rot)
    return (tx + s * (ca * x - sa * y), ty + s * (sa * x + ca * y), tz + sz * z)


# ----------------------------- основной сценарий -----------------------------
def run(project, out_path=None, epsg_arg='auto', crs_datum='wgs84', mode='4', strict=False,
        height_mode='ellipsoidal', max_gap=2.0, accept_status=None, use_scale=True,
        local_plan='xy', las_origin=None, las_path=None, verbose=False, fit_z_scale=False):
    report = {'schema': 'georef-rtk/1', 'generated': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
              'project': os.path.abspath(project), 'ok': False, 'warnings': []}
    pd = os.path.join(project, 'project_data')
    gnss_path = os.path.join(pd, 'gnss.csv')
    poses_path = os.path.join(pd, 'poses.csv')
    for k, pth in (('gnss_csv', gnss_path), ('poses_csv', poses_path)):
        report[k] = pth
    if not os.path.exists(gnss_path) or not os.path.exists(poses_path):
        report['error'] = 'нет %s или %s' % (gnss_path, poses_path)
        return 2, report, 'нет файлов проекта: нужны project_data/gnss.csv и project_data/poses.csv'
    accepted = accept_status or ['auto']
    if isinstance(accepted, str):
        accepted = [s.strip() for s in accepted.split(',')]
    fixes, rejected, n_rows, hdr = parse_gnss(gnss_path, accepted)
    poses, pose_hdr = parse_poses(poses_path)
    report['input'] = {'gnss_columns': hdr, 'gnss_rows': n_rows, 'gnss_fix_rows': len(fixes),
                       'gnss_rejected_rows': rejected, 'poses_rows': len(poses),
                       'accept_status': accepted, 'local_plan': local_plan}
    if verbose:
        print('gnss.csv: строк %d, fix %d; poses: %d' % (n_rows, len(fixes), len(poses)))
    if len(fixes) == 0:
        report['error'] = 'нет данных RTK fix в gnss.csv (строк %d)' % n_rows
        return 2, report, ('нет данных fix: в gnss.csv %d строк, но ни одна не RTK fix '
                           '(status/gnss_type не fix или файл пуст)' % n_rows)
    pairs, span = interpolate_gnss(poses, fixes, max_gap=max_gap, height_mode=height_mode)
    report['fix'] = {'n_fix_rows': len(fixes), 'n_matched_poses': len(pairs),
                     'time_span_s': span.get('span_s', 0.0), 'height_mode': height_mode,
                     'max_gap_s': max_gap}
    if len(pairs) < 3:
        report['error'] = 'общих точек поз+fix: %d (<3)' % len(pairs)
        return 2, report, ('недостаточно общих точек: %d (нужно >=3; проверьте, что RTK писался '
                           'одновременно с позами, окно %.1f с)' % (len(pairs), max_gap))
    # ---- перевод в кадр скана (X,Y,Z; Z вверх) ----
    ox, oy, oz = (las_origin or [0.0, 0.0, 0.0])
    points = []
    for pr in pairs:
        p = pr['pose']
        if local_plan == 'xz':
            # модель/облако y-up: x,z — план, y — вверх
            if las_origin:
                X = p['x'] + ox
                Y = oy - p['z']
                Z = p['y'] + oz
            else:
                X = p['x']; Y = p['z']; Z = p['y']
        else:
            # Lixel poses: x,y — план, z — вверх
            X = p['x']; Y = p['y']; Z = p['z']
        MY = (p['y'] if (local_plan == 'xz' and las_origin) else Z)
        points.append({'X': X, 'Y': Y, 'Z': Z, 'MY': MY, 'lat': pr['lat'], 'lon': pr['lon'],
                       'alt': pr['alt'], 't': p['t']})
    # ---- CRS ----
    mean_lat = sum(p['lat'] for p in points) / len(points)
    mean_lon = sum(p['lon'] for p in points) / len(points)
    zone_auto = utm_zone_of(mean_lon)
    hemi = 'N' if mean_lat >= 0 else 'S'
    warnings = []
    if epsg_arg and str(epsg_arg).lower() != 'auto':
        epsg_used = int(epsg_arg)
        z, dt, h = datum_of_epsg(epsg_used)
        if z is None:
            return 1, report, 'поддерживаются EPSG 25801–25860 (ETRS89/UTM) и 32601–32660 (WGS84/UTM)'
        if z != zone_auto:
            warnings.append('EPSG:%d — зона %d%s (CM %.0f°), объект на %.3f° (зона %dN): искажение '
                            'масштаба; рекомендуется EPSG:%d' % (
                                epsg_used, z, h, central_meridian(z), mean_lon, zone_auto,
                                epsg_for(zone_auto, 'wgs84')))
        zone_used, datum_used, hemi = z, dt, h
    else:
        zone_used, datum_used = zone_auto, crs_datum
        epsg_used = epsg_for(zone_used, datum_used)
    if crs_datum == 'etrs89' and str(epsg_arg).lower() == 'auto':
        warnings.append('использован ETRS89 EPSG:%d; WGS84-UTM той же зоны — EPSG:%d '
                        '(в Украине разница ~0.5–1 м)' % (epsg_used, epsg_for(zone_used, 'wgs84')))
    report['crs'] = {'epsg': epsg_used, 'zone': zone_used, 'hemisphere': hemi,
                     'datum': datum_used, 'central_meridian_deg': central_meridian(zone_used),
                     'name': CRS_NAMES[datum_used].format(zone=zone_used, hemi=hemi),
                     'wkt': wkt_utm(zone_used, datum_used, hemi)}
    # ---- UTM для точек ----
    ecef_check = []
    for p in points:
        p['E'], p['N'] = utm_forward(p['lat'], p['lon'], zone_used, datum_used)
        p['H'] = p['alt']
        if verbose:
            ex, ey, ez = latlon_to_ecef(p['lat'], p['lon'], p['alt'], datum_used)
            la, lo, hh = ecef_to_latlon(ex, ey, ez, datum_used)
            ecef_check.append({'ecef_roundtrip_m': math.sqrt((ex - ex) ** 2 + (ey - ey) ** 2 + (ez - ez) ** 2),
                               'lat_err': abs(la - p['lat']), 'lon_err': abs(lo - p['lon']),
                               'h_err': abs(hh - p['alt'])})
    # ---- трансформация ----
    try:
        if mode == '7':
            tr = fit_7param(points)
            z_scale, tz = tr['scale'], tr['translation'][2]
        else:
            tr = fit_4param(points, use_scale=use_scale)
            z_scale, tz = fit_height(points, fit_scale=bool(fit_z_scale))
            tr['z_scale'] = z_scale
            tr['translation_z'] = tz
            # вертикальные невязки
            hres = []
            for p, rec in zip(points, tr['residuals']):
                hp = z_scale * p['Z'] + tz
                hres.append(abs(hp - p['H']))
                rec['d_h'] = hres[-1]
            tr['rms_h'] = math.sqrt(sum(v * v for v in hres) / len(hres))
            tr['max_h'] = max(hres)
    except ValueError as e:
        report['error'] = str(e)
        return 2, report, 'недостаточно/вырожденные точки: %s' % e
    rms2 = tr.get('rms_2d', 0.0); max2 = tr.get('max_2d', 0.0)
    rms3 = tr.get('rms_3d', rms2); max3 = tr.get('max_3d', max2)
    ok = (tr['n_points'] >= 3) and (max3 <= 0.15)
    if not ok:
        warnings.append('для --strict: n=%d, max=%.3f м (порог 0.15 м)' % (tr['n_points'], max3))
    # ---- IfcMapConversion ----
    if tr['mode'] == 7:
        rot_rad = math.radians(tr['rotation_deg'])
        scale_ifc = tr['scale']
        tx, ty, tz_ifc = tr['translation']
        src_tr = None if not (local_plan == 'xz' and las_origin) else {'axis': 'zup', 't': [0.0, 0.0, 0.0]}
        if src_tr:
            # геометрия IFC = (model x, -model z): Xp = X-ox, Yp = Y-oy
            cs, sn = math.cos(rot_rad), math.sin(rot_rad)
            e0 = tx + scale_ifc * (cs * ox - sn * oy)
            n0 = ty + scale_ifc * (sn * ox + cs * oy)
            h0 = tz_ifc + scale_ifc * oz
        else:
            e0, n0, h0 = tx, ty, tz_ifc
    else:
        rot_rad = math.radians(tr['rotation_deg'])
        scale_ifc = tr['scale']
        tx, ty = tr['translation'][:2]
        tz = tr['translation_z']
        if local_plan == 'xz' and las_origin:
            src_tr = {'axis': 'zup', 't': [0.0, 0.0, 0.0]}
            cs, sn = math.cos(rot_rad), math.sin(rot_rad)
            e0 = tx + scale_ifc * (cs * ox - sn * oy)
            n0 = ty + scale_ifc * (sn * ox + cs * oy)
            # высота: горизонтальный масштаб IfcMapConversion применяется и к Z, поэтому
            # компенсируем его вертикальным масштабом МНК (sz, обычно 1): H0 = tz + sz*oz
            h0 = tz + z_scale * oz
        else:
            src_tr = None
            e0, n0, h0 = tx, ty, tz
    ifc = {'eastings': e0, 'northings': n0, 'orthogonal_height': h0,
           'x_axis_abscissa': math.cos(rot_rad), 'x_axis_ordinate': math.sin(rot_rad),
           'scale': scale_ifc}
    if src_tr:
        ifc['source_transform'] = src_tr
        ifc['mirror_z'] = True
    # проверка IFC-формулы на общих точках
    ifc_check = []
    for p, rec in zip(points, tr['residuals']):
        if src_tr:
            Xp = (p['X'] - ox) if las_origin else p['X']
            Yp = (p['Y'] - oy) if las_origin else p['Y']
        else:
            Xp, Yp = p['X'], p['Y']
        e = e0 + scale_ifc * (math.cos(rot_rad) * Xp - math.sin(rot_rad) * Yp)
        n = n0 + scale_ifc * (math.sin(rot_rad) * Xp + math.cos(rot_rad) * Yp)
        h = h0 + scale_ifc * p['MY']
        if tr['mode'] == 4:
            h_pred = z_scale * p['Z'] + tz
        else:
            h_pred = float(rec.get('pred_h', h))
        # проверяем, что формула IfcMapConversion воспроизводит предсказание МНК-трансформации
        ifc_check.append({'t': p['t'],
                          'err2d': math.hypot(e - rec['pred_e'], n - rec['pred_n']),
                          'err_h': abs(h - h_pred),
                          'local': [Xp, Yp, p['MY']], 'pred': [e, n, h],
                          'utm': [rec['utm_e'], rec['utm_n'], p['H']]})
    # ---- bbox ----
    extra = None
    las = las_path or (find_las(project) if local_plan == 'xy' else None)
    if las and os.path.exists(las):
        bb = read_las_bbox(las)
        if bb:
            extra = [(bb[0], bb[2], bb[4]), (bb[0], bb[3], bb[4]), (bb[1], bb[2], bb[4]),
                     (bb[1], bb[3], bb[4]), (bb[0], bb[2], bb[5]), (bb[1], bb[3], bb[5])]
    bbox = bbox_utm(points, tr, extra)
    bbox['source'] = las if extra else 'poses'
    if not extra:
        warnings.append('LAS не найден/не того кадра: bbox оценён по позам (--las для точного bbox)')
    # ---- сборка отчёта ----
    report['fix'].update({'rms_2d_m': rms2, 'max_2d_m': max2, 'rms_3d_m': rms3, 'max_3d_m': max3,
                          'rms_h_m': tr.get('rms_h'), 'max_h_m': tr.get('max_h')})
    report['transform'] = {
        'mode': tr['mode'], 'local_plan': local_plan,
        'rotation_deg': math.degrees(rot_rad), 'scale': scale_ifc,
        'translation': [e0, n0, h0] if src_tr else ([tx, ty, tz] if tr['mode'] == 4 else [*tx, ty, tz]),
        'translation_scan_frame': ([tx, ty, tz] if tr['mode'] == 4 else tr['translation']),
        'ifc_map_conversion': ifc,
        'ifc_check': ifc_check,
        'residual_per_point': tr['residuals'],
        'accuracy': {'rms_m': rms3, 'max_m': max3, 'threshold_strict_m': 0.15,
                     'points': tr['n_points'], 'passed_strict': bool(ok)},
    }
    if tr['mode'] == 7:
        report['transform']['euler_deg'] = tr.get('euler_deg')
    if verbose and ecef_check:
        report['ecef_roundtrip'] = {'max_err_m': max(c['ecef_roundtrip_m'] for c in ecef_check),
                                     'max_lat_deg': max(c['lat_err'] for c in ecef_check),
                                     'max_lon_deg': max(c['lon_err'] for c in ecef_check)}
    report['cloud_bbox_utm'] = bbox
    report['warnings'] = warnings
    report['ok'] = bool(ok)
    report['strict'] = bool(strict)
    if out_path:
        d = os.path.dirname(os.path.abspath(out_path))
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = out_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        os.replace(tmp, out_path)
    # ---- печать ----
    print('=== georef-rtk: %s ===' % os.path.basename(os.path.abspath(project)))
    print('CRS: EPSG:%s %s (зона %d%s, CM %.0f°)' % (
        epsg_used, report['crs']['name'], zone_used, hemi, central_meridian(zone_used)))
    print('GNSS: строк %d | fix %d | сопоставлено с позами %d | окно %.1f с' % (
        n_rows, len(fixes), len(pairs), span.get('span_s', 0.0)))
    if tr['mode'] == 4:
        print('Трансформация 4-парам: поворот %.6f°, масштаб %.8f, сдвиг E0=%.3f N0=%.3f H0=%.3f' % (
            math.degrees(rot_rad), scale_ifc, e0, n0, h0))
        print('Невязки: rms %.4f м, max %.4f м (2D); h: rms %.4f м | точек %d' % (
            rms2, max2, tr.get('rms_h', 0.0), tr['n_points']))
    else:
        print('Трансформация 7-парам: yaw %.6f°, масштаб %.8f, сдвиг [%.3f, %.3f, %.3f]' % (
            math.degrees(rot_rad), scale_ifc, *tr['translation']))
        print('Невязки 3D: rms %.4f м, max %.4f м; euler [%.4f, %.4f, %.4f]° | точек %d' % (
            rms3, max3, *tr.get('euler_deg', [0, 0, 0]), tr['n_points']))
    print('IfcMapConversion: Eastings %.3f Northings %.3f OrthoH %.3f XAxis(cos,sin) %.7f/%.7f Scale %.8f' % (
        e0, n0, h0, ifc['x_axis_abscissa'], ifc['x_axis_ordinate'], scale_ifc))
    if src_tr:
        print('Ifc sourceTransform: axis=zup t=[0,0,0] (план зеркалится: IFC X=x, Y=-z модели)')
    print('bbox облака в UTM: min [%.2f, %.2f, %.2f] max [%.2f, %.2f, %.2f] (%s)' % (
        bbox['min'][0], bbox['min'][1], bbox['min'][2], bbox['max'][0], bbox['max'][1],
        bbox['max'][2], bbox['source']))
    print('\n%-4s %-12s %-22s %-26s %-8s' % ('#', 't, с', 'локальные план X,Y', 'UTM E,N', '2D, мм'))
    for i, rec in enumerate(tr['residuals'][:40]):
        p = points[i]
        print('%-4d %-12.2f %-22s %-26s %-8.1f' % (
            i + 1, p['t'], '(%.3f, %.3f)' % (rec['local_x'], rec['local_y']),
            '(%.3f, %.3f)' % (rec['utm_e'], rec['utm_n']), rec['d2d'] * 1000))
    if len(tr['residuals']) > 40:
        print('... ещё %d точек' % (len(tr['residuals']) - 40))
    for w in warnings:
        print('ВНИМАНИЕ: %s' % w)
    if out_path:
        print('\nзаписано: %s' % os.path.abspath(out_path))
    if strict and not ok:
        return 1, report, 'strict: max невязка %.3f м > 0.15 м (точек %d)' % (max3, tr['n_points'])
    return 0, report, 'ok'


def parse_origin(s):
    if not s:
        return None
    vals = [float(v) for v in s.replace(';', ',').split(',')]
    if len(vals) != 3:
        raise ValueError('origin: нужны три числа через запятую')
    return vals


def main(argv=None):
    ap = argparse.ArgumentParser(
        description='Привязка облака Lixel к реальным координатам по RTK (georef.json)')
    ap.add_argument('--project', required=True, help='папка проекта Lixel (внутри project_data/)')
    ap.add_argument('--out', default=None, help='куда писать georef.json (по умолчанию <project>/georef.json)')
    ap.add_argument('--epsg', default='auto',
                    help='EPSG UTM: 25801–25860 (ETRS89), 32601–32660 (WGS84); auto — по долготе')
    ap.add_argument('--crs', default='wgs84', choices=['wgs84', 'etrs89'],
                    help='датум при auto (wgs84 по умолчанию; etrs89 → EPSG:258xx)')
    ap.add_argument('--mode', default='4', choices=['4', '7'], help='4- или 7-параметрическая')
    ap.add_argument('--local-plan', default='xy', choices=['xy', 'xz'],
                    help='xy: Lixel poses x,y план/z вверх; xz: модель (x,z план, y вверх)')
    ap.add_argument('--from-las-origin', default=None,
                    help='origin из las-to-bin.js "ox,oy,oz" (модель y-up → кадр скана)')
    ap.add_argument('--height', default='ellipsoidal', choices=['ellipsoidal', 'orthometric'],
                    help='высоты в gnss.csv (orthometric → прибавить undulation)')
    ap.add_argument('--max-gap', type=float, default=2.0, help='макс. разрыв между fix, с (2.0)')
    ap.add_argument('--accept-status', default='auto',
                    help='какие status считать fix: auto | "3,4,5,fix"')
    ap.add_argument('--no-scale', action='store_true', help='не оценивать масштаб плана')
    ap.add_argument('--fit-z-scale', action='store_true',
                    help='оценивать и масштаб по высоте (по умолчанию sz=1)')
    ap.add_argument('--las', default=None, help='LAS/LAZ облака для bbox')
    ap.add_argument('--strict', action='store_true', help='exit 1 при max невязке >0.15 м или точках <3')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args(argv)
    out = a.out or os.path.join(a.project, 'georef.json')
    try:
        origin = parse_origin(a.from_las_origin)
    except ValueError as e:
        print('ОШИБКА: %s' % e, file=sys.stderr)
        return 1
    try:
        code, report, msg = run(a.project, out, epsg_arg=a.epsg, crs_datum=a.crs, mode=a.mode,
                                strict=a.strict, height_mode=a.height, max_gap=a.max_gap,
                                accept_status=a.accept_status, use_scale=not a.no_scale,
                                local_plan=a.local_plan, las_origin=origin, las_path=a.las,
                                verbose=a.verbose, fit_z_scale=a.fit_z_scale)
    except FileNotFoundError as e:
        print('ОШИБКА: %s' % e, file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001
        print('ОШИБКА: %s' % e, file=sys.stderr)
        return 1
    if code != 0:
        print('РЕЗУЛЬТАТ: %s' % msg, file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
