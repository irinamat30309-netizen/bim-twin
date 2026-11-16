# -*- coding: utf-8 -*-
"""crs-tools.py — P2: система координат для облаков (CRS) для приложения BIM Twin.

Возможности:
  * показать текущую привязку LAS (EPSG/WKT из VLR), bbox и углы в WGS84;
  * пересчитать облако UTM ↔ WGS84 ↔ ETRS89/UTM ↔ локальная (УСК) система;
  * записать WKT/GeoKey VLR в LAS (--update-header) и пересчитанный LAS (--out-las);
  * экспортировать углы bbox/координаты в JSON (для UI-панели «Система координат»);
  * сформировать georef.json для IFC (json-to-ifc.js --georef-file).

Точность: Karney/Krüger Transverse Mercator (ряд до n^6) — nm-уровень roundtrip;
ETRS89 (EPSG:25836) и WGS84 (32636) различаются реализацией датума (<1 м).
Поддержанные EPSG: 4326 (WGS84 geographic), 326xx (WGS84/UTM), 258xx (ETRS89/UTM),
локальная («УСК»/local) — по параметрам --local-params E0,N0,theta_deg,scale.

CLI:
  python tools/scan2bim-py/crs-tools.py --in cloud.las --epsg 32636 --to 4326 --json out.json
  python tools/scan2bim-py/crs-tools.py --in cloud.las --epsg 32636 --to 25836 \
         --out-las cloud-25836.las --json out.json
  python tools/scan2bim-py/crs-tools.py --in cloud.las --update-header --epsg 32636 \
         --out-las cloud-crs.las
  python tools/scan2bim-py/crs-tools.py --in cloud.las --epsg 32636 --to 32636 \
         --georef-file georef.json --json out.json
  python tools/scan2bim-py/crs-tools.py --in cloud.las --epsg 32636 --to local \
         --local-params 322000,5588000,0,1 --json out.json
Коды: 0 — успех, 2 — ошибка входа, 1 — операция не удалась.
"""
import argparse
import json
import math
import os
import struct
import sys
import time

import numpy as np

# ======================= параметры эллипсоидов =======================
DATUMS = {
    'wgs84': (6378137.0, 1 / 298.257223563, 'WGS 84'),
    'etrs89': (6378137.0, 1 / 298.257222101, 'ETRS89'),
}
EPSG_DATUM = {}
for z in range(1, 61):
    EPSG_DATUM[32600 + z] = ('wgs84', z, 'N')
    EPSG_DATUM[32700 + z] = ('wgs84', z, 'S')
    EPSG_DATUM[25800 + z] = ('etrs89', z, 'N')   # ETRS89/UTM (зоны 28-38 реально)
GEOGRAPHIC_EPSG = {4326: 'wgs84', 4258: 'etrs89', 4284: 'pulkovo'}  # 4284 без датума-параметров


def norm_lon(x):
    while x > 180.0:
        x -= 360.0
    while x < -180.0:
        x += 360.0
    return x


def epsg_info(epsg):
    """→ dict(kind='geographic'|'projected'|'local', datum, zone, hemi, name)."""
    try:
        e = int(epsg)
    except (TypeError, ValueError):
        raise ValueError('EPSG должен быть числом: %r' % (epsg,))
    if e in GEOGRAPHIC_EPSG:
        return {'kind': 'geographic', 'datum': GEOGRAPHIC_EPSG[e], 'zone': None,
                'hemi': None, 'name': 'EPSG:%d' % e}
    if e in EPSG_DATUM:
        datum, zone, hemi = EPSG_DATUM[e]
        return {'kind': 'projected', 'datum': datum, 'zone': zone, 'hemi': hemi,
                'name': 'EPSG:%d' % e}
    raise ValueError('неподдерживаемый EPSG: %d (4326, 258xx, 326xx/327xx)' % e)


# ======================= Karney TM =======================
class TM:
    def __init__(self, datum='wgs84', zone=36, hemi='N', k0=0.9996):
        self.a, self.f, self.name = DATUMS[datum]
        self.zone = int(zone)
        self.hemi = hemi
        self.k0 = k0
        self.fe = 500000.0
        self.fn = 10000000.0 if hemi == 'S' else 0.0
        self.lon0 = self.zone * 6 - 183
        if hemi == 'S':
            self.lon0 = self.zone * 6 - 183
        n = self.f / (2 - self.f)
        n2, n3, n4, n5, n6 = n ** 2, n ** 3, n ** 4, n ** 5, n ** 6
        self.A = self.a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256)
        self.alpha = [
            n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
            13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
            61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
            49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
            34729 * n5 / 80640 - 3418889 * n6 / 1995840,
            212378941 * n6 / 319334400,
        ]
        self.beta = [
            n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
            n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
            17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
            4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
            4583 * n5 / 161280 - 108847 * n6 / 3991680,
            20648693 * n6 / 638668800,
        ]
        self.e = math.sqrt(self.f * (2 - self.f))

    def forward(self, lat_deg, lon_deg):
        phi = math.radians(lat_deg)
        lam = math.radians(norm_lon(lon_deg - self.lon0))
        tau = math.tan(phi)
        e = self.e
        taup = math.sinh(math.asinh(tau) -
                         e * math.atanh(e * tau / math.hypot(1.0, tau)))
        xip = math.atan2(taup, math.cos(lam))
        etap = math.asinh(math.sin(lam) / math.hypot(taup, math.cos(lam)))
        xi, eta = xip, etap
        for j, al in enumerate(self.alpha, start=1):
            xi += al * math.sin(2 * j * xip) * math.cosh(2 * j * etap)
            eta += al * math.cos(2 * j * xip) * math.sinh(2 * j * etap)
        return self.fe + self.k0 * self.A * eta, self.fn + self.k0 * self.A * xi

    def inverse(self, easting, northing):
        eta = (easting - self.fe) / (self.k0 * self.A)
        xi = (northing - self.fn) / (self.k0 * self.A)
        xip, etap = xi, eta
        for j, be in enumerate(self.beta, start=1):
            xip -= be * math.sin(2 * j * xi) * math.cosh(2 * j * eta)
            etap -= be * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
        s = math.sin(xip) / math.cosh(etap)
        taup = s / math.sqrt(max(1e-15, 1.0 - s * s))
        lam = math.atan2(math.sinh(etap), math.cos(xip))
        e = self.e
        u = math.asinh(taup)
        for _ in range(6):
            u = math.asinh(taup) + e * math.atanh(e * math.tanh(u))
        tau = math.sinh(u)
        return math.degrees(math.atan(tau)), norm_lon(self.lon0 + math.degrees(lam))


def utm_of_epsg(epsg):
    info = epsg_info(epsg)
    if info['kind'] != 'projected':
        raise ValueError('EPSG:%d — не проекционная UTM' % epsg)
    return TM(info['datum'], info['zone'], info['hemi'])


def wkt_for(epsg):
    info = epsg_info(epsg)
    if info['kind'] == 'geographic':
        datum = 'WGS_1984' if info['datum'] == 'wgs84' else 'European_Terrestrial_Reference_System_1989'
        dname = 'World Geodetic System 1984' if info['datum'] == 'wgs84' else 'European Terrestrial Reference System 1989'
        return ('GEOGCRS["%s",DATUM["%s",ELLIPSOID["WGS 84",6378137,298.257223563,'
                'LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],'
                'CS[ellipsoidal,2],AXIS["geodetic latitude (Lat)",north,ORDER[1],'
                'ANGLEUNIT["degree",0.0174532925199433]],AXIS["geodetic longitude (Lon)",east,ORDER[2],'
                'ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",%d]]' % (dname, dname, epsg))
    datum = 'World Geodetic System 1984' if info['datum'] == 'wgs84' else 'European Terrestrial Reference System 1989'
    pid = 6326 if info['datum'] == 'wgs84' else 6258
    return ('PROJCRS["UTM zone %d%s",BASEGEOGCRS["%s",DATUM["%s",ELLIPSOID["WGS 84",6378137,'
            '298.257223563,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,'
            'ANGLEUNIT["degree",0.0174532925199433]]],CONVERSION["UTM zone %d%s",'
            'METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,'
            'ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of natural origin",%d,'
            'ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor at natural origin",0.9996,'
            'SCALEUNIT["unity",1]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],'
            'PARAMETER["False northing",%d,LENGTHUNIT["metre",1]]],CS[Cartesian,2],'
            'AXIS["easting (E)",east,ORDER[1],LENGTHUNIT["metre",1]],'
            'AXIS["northing (N)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",%d]]'
            % (info['zone'], info['hemi'], datum, datum, info['zone'], info['hemi'],
               info['zone'] * 6 - 183, 10000000 if info['hemi'] == 'S' else 0, epsg))


# ======================= LAS =======================
def read_las_header(path):
    with open(path, 'rb') as f:
        h = f.read(375)
    if h[:4] != b'LASF':
        raise ValueError('не LAS: ' + path)
    ver = (h[24], h[25])
    hsize = struct.unpack_from('<H', h, 94)[0]
    off = struct.unpack_from('<I', h, 96)[0]
    nvlr = struct.unpack_from('<I', h, 100)[0]
    fmt = h[104] & 0x3F
    rl = struct.unpack_from('<H', h, 105)[0]
    n = struct.unpack_from('<I', h, 107)[0]
    if ver >= (1, 4) and hsize >= 375:
        n14 = struct.unpack_from('<Q', h, 247)[0]
        if n14:
            n = n14
    scale = struct.unpack_from('<ddd', h, 131)
    offset = struct.unpack_from('<ddd', h, 155)
    bbox = struct.unpack_from('<dddddd', h, 179)
    rgb_off = 28 if fmt in (2, 3, 5, 7, 8, 10) else None
    return {'path': path, 'ver': ver, 'hsize': hsize, 'off': off, 'nvlr': nvlr, 'fmt': fmt,
            'rl': rl, 'n': int(n), 'scale': scale, 'offset': offset,
            'bbox': (bbox[1], bbox[3], bbox[5], bbox[0], bbox[2], bbox[4]),
            'rgb_off': rgb_off, 'size': os.path.getsize(path)}


def read_las_vlrs(path):
    """Читает VLR: список (user_id, record_id, description, data)."""
    H = read_las_header(path)
    out = []
    with open(path, 'rb') as f:
        f.seek(H['hsize'])
        for _ in range(H['nvlr']):
            raw = f.read(54)
            if len(raw) < 54:
                break
            reserved, user_id, rec_id, rec_len, desc = struct.unpack('<H16sHH32s', raw)
            data = f.read(rec_len)
            out.append({'user_id': user_id.rstrip(b'\x00').decode('latin-1', 'replace'),
                        'record_id': rec_id,
                        'description': desc.rstrip(b'\x00').decode('latin-1', 'replace'),
                        'data': data})
    return out


def las_crs_from_vlrs(vlrs):
    """Ищет EPSG в GeoKeyDirectory (34735) и WKT в 4224 → (epsg|None, wkt|None)."""
    epsg = None
    wkt = None
    for v in vlrs:
        if v['record_id'] == 34735 and len(v['data']) >= 8:
            try:
                keys = struct.unpack('<%dH' % (len(v['data']) // 2), v['data'][:len(v['data']) // 2 * 2])
                nkeys = keys[3]
                for i in range(nkeys):
                    base = 4 + i * 4
                    key_id, loc, _cnt, val = keys[base:base + 4]
                    if key_id in (3072, 4096, 2048) and loc == 0:
                        epsg = int(val) if key_id == 3072 else epsg
            except Exception:
                pass
        if v['record_id'] == 4224:
            wkt = v['data'].rstrip(b'\x00').decode('latin-1', 'replace')
    return epsg, wkt


def read_ply_points(path):
    try:
        import open3d as o3d
    except Exception:  # noqa: BLE001
        raise RuntimeError('PLY: нужен open3d')
    pc = o3d.io.read_point_cloud(path)
    P = np.asarray(pc.points, dtype=np.float64)
    return P, None


def iter_las_chunks(path, H, chunk=1 << 20):
    rl = H['rl']
    with open(path, 'rb') as f:
        f.seek(H['off'])
        for i0 in range(0, H['n'], chunk):
            c = min(chunk, H['n'] - i0)
            buf = f.read(c * rl)
            if len(buf) < c * rl:
                break
            rec = np.frombuffer(buf, dtype=np.uint8).reshape(c, rl)
            X = rec[:, 0:4].copy().view('<i4').reshape(c).astype(np.float64)
            Y = rec[:, 4:8].copy().view('<i4').reshape(c).astype(np.float64)
            Z = rec[:, 8:12].copy().view('<i4').reshape(c).astype(np.float64)
            sx, sy, sz = H['scale']
            ox, oy, oz = H['offset']
            xyz = np.column_stack([X * sx + ox, Y * sy + oy, Z * sz + oz])
            rgb = None
            if H['rgb_off'] is not None:
                ro = H['rgb_off']
                rgb = np.column_stack([rec[:, ro:ro + 2].copy().view('<u2').reshape(c),
                                       rec[:, ro + 2:ro + 4].copy().view('<u2').reshape(c),
                                       rec[:, ro + 4:ro + 6].copy().view('<u2').reshape(c)])
            yield xyz, rgb


def transform_las(path, to_epsg, out_path, source_epsg, max_points=None, local_params=None):
    """Пересчитывает LAS из source_epsg в to_epsg и пишет LAS с VLR/WKT. → статистика."""
    H = read_las_header(path)
    src = epsg_info(source_epsg)
    # to_epsg == 0 → локальная (УСК/local) система: не EPSG-код
    dst = {'kind': 'local', 'datum': None, 'zone': None, 'hemi': None,
           'name': 'USK/local'} if int(to_epsg) == 0 else epsg_info(to_epsg)
    t0 = time.time()
    # функции преобразования (E,N,H) → target coords
    if src['kind'] == 'projected':
        tm_src = utm_of_epsg(source_epsg)
        def to_lonlat(E, N):
            return np.vectorize(tm_src.inverse, otypes=[np.float64, np.float64])(E, N) \
                if len(E) < 5000 else _vec_ll(tm_src, E, N)
    elif src['kind'] == 'geographic':
        def to_lonlat(E, N):
            return (N, E)   # вход уже lon,lat (X=lon, Y=lat)
    else:
        raise ValueError('локальный источник не поддержан для пересчёта')
    if dst['kind'] == 'projected':
        tm_dst = utm_of_epsg(to_epsg)
        def from_lonlat(lat, lon):
            return _vec_en(tm_dst, lat, lon)
    elif dst['kind'] == 'geographic':
        def from_lonlat(lat, lon):
            return lon, lat
    elif dst['kind'] == 'local':
        if not local_params:
            raise ValueError('--to local: нужны --local-params E0,N0,theta_deg,scale')
        E0, N0, th, sc = local_params
        th = math.radians(th)
        def from_lonlat(lat, lon):
            # local относительно UTM36N (или source projected)
            tm = tm_src if src['kind'] == 'projected' else TM('wgs84', 36, 'N')
            E, N = _vec_en(tm, lat, lon)
            x = ((E - E0) * math.cos(th) + (N - N0) * math.sin(th)) / sc
            y = (-(E - E0) * math.sin(th) + (N - N0) * math.cos(th)) / sc
            return x, y
    else:
        raise ValueError('цель не поддержана')
    # считаем все точки
    xs, ys, zs, rgbs = [], [], [], []
    total = 0
    src_epsg_ok = src['kind']
    for xyz, rgb in iter_las_chunks(path, H, 1 << 20):
        if max_points and total + len(xyz) > max_points:
            k = max_points - total
            xyz = xyz[:k]
            rgb = rgb[:k] if rgb is not None else None
        total += len(xyz)
        E, N, Z = xyz[:, 0], xyz[:, 1], xyz[:, 2]
        if src['kind'] == 'projected':
            lat, lon = _vec_ll(tm_src, E, N)
        else:
            lat, lon = N, E
        if dst['kind'] == 'projected':
            x2, y2 = _vec_en(tm_dst, lat, lon)
            z2 = Z
        elif dst['kind'] == 'geographic':
            x2, y2, z2 = lon, lat, Z
        else:
            E0, N0, th, sc = local_params
            th = math.radians(th)
            if src['kind'] == 'projected':
                Ex, Nx = E, N
            else:
                Ex, Nx = _vec_en(tm_src if src['kind'] == 'projected' else TM('wgs84', 36, 'N'), lat, lon)
            x2 = ((Ex - E0) * math.cos(th) + (Nx - N0) * math.sin(th)) / sc
            y2 = (-(Ex - E0) * math.sin(th) + (Nx - N0) * math.cos(th)) / sc
            z2 = Z
        xs.append(x2); ys.append(y2); zs.append(z2)
        if rgb is not None:
            rgbs.append(rgb)
        if max_points and total >= max_points:
            break
    X = np.concatenate(xs); Y = np.concatenate(ys); Z = np.concatenate(zs)
    RGB = np.concatenate(rgbs) if rgbs else None
    wkt = wkt_for(to_epsg) if dst['kind'] != 'local' else \
        'LOCAL_CS["USK/local",LOCAL_DATUM["local",0],UNIT["metre",1],AXIS["X",EAST],AXIS["Y",NORTH],ORDER[1]]'
    info = write_las(out_path, np.column_stack([X, Y, Z]), RGB, wkt=wkt,
                     epsg=None if dst['kind'] == 'local' else to_epsg)
    info.update({'source_epsg': source_epsg, 'target_epsg': to_epsg,
                 'bbox_before': [float(v) for v in H['bbox']],
                 'bbox_after': [float(X.min()), float(Y.min()), float(Z.min()),
                                float(X.max()), float(Y.max()), float(Z.max())],
                 'seconds': round(time.time() - t0, 2), 'points': int(len(X)),
                 'wkt': wkt})
    return info


def _vec_ll(tm, E, N):
    """Векторный inverse TM (простой цикл с numpy-вызовами)."""
    E = np.asarray(E, dtype=np.float64); N = np.asarray(N, dtype=np.float64)
    eta = (E - tm.fe) / (tm.k0 * tm.A)
    xi = (N - tm.fn) / (tm.k0 * tm.A)
    xip = xi.copy(); etap = eta.copy()
    for j, be in enumerate(tm.beta, start=1):
        xip -= be * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        etap -= be * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    s = np.sin(xip) / np.cosh(etap)
    taup = s / np.sqrt(np.maximum(1e-15, 1.0 - s * s))
    lam = np.arctan2(np.sinh(etap), np.cos(xip))
    e = tm.e
    u = np.arcsinh(taup)
    for _ in range(6):
        u = np.arcsinh(taup) + e * np.arctanh(e * np.tanh(u))
    tau = np.sinh(u)
    return np.degrees(np.arctan(tau)), ((tm.lon0 + np.degrees(lam) + 180.0) % 360.0) - 180.0


def _vec_en(tm, lat, lon):
    lat = np.asarray(lat, dtype=np.float64); lon = np.asarray(lon, dtype=np.float64)
    phi = np.radians(lat)
    lam = np.radians(((lon - tm.lon0 + 180.0) % 360.0) - 180.0)
    tau = np.tan(phi)
    e = tm.e
    taup = np.sinh(np.arcsinh(tau) -
                   e * np.arctanh(np.clip(e * tau / np.hypot(1.0, tau), -0.999999999,
                                          0.999999999)))
    xip = np.arctan2(taup, np.cos(lam))
    etap = np.arcsinh(np.sin(lam) / np.hypot(taup, np.cos(lam)))
    xi = xip.copy(); eta = etap.copy()
    for j, al in enumerate(tm.alpha, start=1):
        xi += al * np.sin(2 * j * xip) * np.cosh(2 * j * etap)
        eta += al * np.cos(2 * j * xip) * np.sinh(2 * j * etap)
    return tm.fe + tm.k0 * tm.A * eta, tm.fn + tm.k0 * tm.A * xi


def _vlr_bytes(user_id, rec_id, data):
    b = bytearray(54)
    struct.pack_into('<H', b, 0, 0)
    uid = user_id.encode('latin-1')[:16].ljust(16, b'\x00')
    b[2:18] = uid
    struct.pack_into('<H', b, 18, rec_id)
    struct.pack_into('<H', b, 20, len(data))
    desc = b'CRS WKT'.ljust(32, b'\x00')
    b[22:54] = desc
    return bytes(b) + data


def write_las(path, pts, rgb=None, wkt=None, epsg=None):
    """Пишет LAS 1.2 fmt 3; при wkt добавляет VLR LASF_Projection/4224 + GeoKeyDirectory.
    Смещение/масштаб подбираются автоматически так, чтобы int32 гарантированно не переполнялся
    (для градусов — 1e-9°, для метров — 0.001 м; при широком диапазоне шаг увеличивается)."""
    pts = np.asarray(pts, dtype=np.float64)
    n = len(pts)
    mn = pts.min(axis=0) if n else np.zeros(3)
    mx = pts.max(axis=0) if n else np.zeros(3)
    geographic = bool(n and abs(mx[0]) < 1000.0 and abs(mx[1]) < 1000.0
                      and abs(mn[0]) < 1000.0 and abs(mn[1]) < 1000.0)
    base = 1e-9 if geographic else 0.001
    span = np.maximum(mx - mn, 1e-12)
    # int32 = ±2.147e9; берём запас: |coord-off|/scale ≤ 1e9
    scale_xy = max(base, float(np.max(span[:2])) / 1.0e9) if n else base
    scale_z = max(0.001, float(span[2]) / 1.0e9) if n else 0.001
    scale = (scale_xy, scale_xy, scale_z)
    off = 0.5 * (mn + mx)   # центрируем — int32 не переполнится ни при каких данных
    hsize = 375
    rec = 34
    vlrs = b''
    nvlr = 0
    if wkt:
        data = wkt.encode('latin-1', 'replace')
        if len(data) % 2:
            data += b'\x00'
        vlrs += _vlr_bytes('LASF_Projection', 4224, data)
        nvlr += 1
    if epsg:
        # GeoKeyDirectory: version 1.1.0, 1 key: 3072 ProjectedCSTypeGeoKey = epsg
        keys = [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, int(epsg)]
        data = struct.pack('<%dH' % len(keys), *keys)
        vlrs += _vlr_bytes('LASF_Projection', 34735, data)
        nvlr += 1
    offbytes = hsize + len(vlrs)
    h = bytearray(375)
    h[0:4] = b'LASF'
    h[24] = 1; h[25] = 2
    struct.pack_into('<H', h, 90, 0)
    struct.pack_into('<H', h, 92, 2026)
    struct.pack_into('<H', h, 94, hsize)
    struct.pack_into('<I', h, 96, offbytes)
    struct.pack_into('<I', h, 100, nvlr)
    h[104] = 3
    struct.pack_into('<H', h, 105, rec)
    struct.pack_into('<I', h, 107, n)
    struct.pack_into('<ddd', h, 131, *scale)
    struct.pack_into('<ddd', h, 155, *off)
    struct.pack_into('<dddddd', h, 179, mx[0], mn[0], mx[1], mn[1], mx[2], mn[2])
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(bytes(h)); f.write(vlrs)
        B = 1 << 16
        for i0 in range(0, n, B):
            c = min(B, n - i0)
            p = pts[i0:i0 + c]
            buf = bytearray(c * rec)
            ix = np.round((p[:, 0] - off[0]) / scale[0]).astype(np.int64)
            iy = np.round((p[:, 1] - off[1]) / scale[1]).astype(np.int64)
            iz = np.round((p[:, 2] - off[2]) / scale[2]).astype(np.int64)
            for k in range(c):
                q = k * rec
                struct.pack_into('<3i', buf, q, int(ix[k]), int(iy[k]), int(iz[k]))
                struct.pack_into('<H', buf, q + 12, 0)
                buf[q + 14] = 0x09
                struct.pack_into('<H', buf, q + 18, 0)
                struct.pack_into('<d', buf, q + 20, 0.0)
                if rgb is not None:
                    r, g, b = int(rgb[i0 + k][0]), int(rgb[i0 + k][1]), int(rgb[i0 + k][2])
                    # 8-битные значения растягиваем в 16-бит, 16-битные пишем как есть
                    if max(r, g, b) <= 255:
                        r, g, b = r * 257, g * 257, b * 257
                    struct.pack_into('<HHH', buf, q + 28, min(r, 65535), min(g, 65535), min(b, 65535))
            f.write(bytes(buf))
    os.replace(tmp, path)
    return {'file': path, 'points': n, 'vlr': nvlr, 'wkt': bool(wkt), 'epsg': epsg}


def bbox_corners_ll(bbox, source_epsg):
    """8 углов bbox → WGS84 lon/lat + исходные E,N,H."""
    E0, N0, Z0, E1, N1, Z1 = bbox
    corners = []
    src = epsg_info(source_epsg)
    if src['kind'] == 'projected':
        tm = utm_of_epsg(source_epsg)
        for E in (E0, E1):
            for N in (N0, N1):
                lat, lon = tm.inverse(E, N)
                corners.append({'E': round(E, 3), 'N': round(N, 3),
                                'lon': round(lon, 8), 'lat': round(lat, 8)})
    else:
        corners = [{'E': E0, 'N': N0, 'lon': E0, 'lat': N0}, {'E': E1, 'N': N1, 'lon': E1, 'lat': N1}]
    return corners


# ======================= CLI =======================
def main(argv=None):
    ap = argparse.ArgumentParser(description='CRS-инструменты: просмотр/пересчёт/запись привязки облака')
    ap.add_argument('--in', dest='inp', required=True, help='облако LAS/PLY (.las/.bin/.ply)')
    ap.add_argument('--epsg', default=None, help='исходный EPSG (если нет VLR): 32636, 25836, 4326')
    ap.add_argument('--to', '--to-epsg', dest='to', default=None,
                    help='целевая система: 4326 | 25836 | 32636 | local/УСК')
    ap.add_argument('--out-las', default=None, help='записать пересчитанное облако (LAS)')
    ap.add_argument('--update-header', action='store_true',
                    help='записать WKT/GeoKey VLR в LAS (без пересчёта точек)')
    ap.add_argument('--json', default=None, help='JSON-отчёт (для UI)')
    ap.add_argument('--georef-file', default=None, help='georef.json для IFC (json-to-ifc.js)')
    ap.add_argument('--local-params', default=None, help='E0,N0,theta_deg,scale для --to local')
    ap.add_argument('--max-points', type=int, default=None, help='ограничить число точек (тест)')
    ap.add_argument('--quiet', action='store_true')
    a = ap.parse_args(argv)
    t0 = time.time()
    rep = {'schema': 'crs-tools/1', 'ok': False, 'in': a.inp,
           'generated': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    try:
        if a.inp.lower().endswith('.ply'):
            P, _ = read_ply_points(a.inp)
            H = None
            bbox = (float(P[:, 0].min()), float(P[:, 1].min()), float(P[:, 2].min()),
                    float(P[:, 0].max()), float(P[:, 1].max()), float(P[:, 2].max()))
            rep['format'] = 'ply'
            rep['points_file'] = int(len(P))
        else:
            H = read_las_header(a.inp)
            vlrs = read_las_vlrs(a.inp)
            rep['format'] = 'las'
            rep['points_file'] = H['n']
            epsg_vlr, wkt_vlr = las_crs_from_vlrs(vlrs)
            rep['vlr'] = {'count': len(vlrs), 'epsg': epsg_vlr, 'has_wkt': bool(wkt_vlr)}
            bbox = H['bbox']
            if a.epsg is None and epsg_vlr:
                a.epsg = str(epsg_vlr)
    except Exception as e:  # noqa: BLE001
        print('ОШИБКА: %s' % e, file=sys.stderr)
        return 2
    src_epsg = int(a.epsg) if a.epsg else 32636
    try:
        info = epsg_info(src_epsg)
    except Exception as e:  # noqa: BLE001
        print('ОШИБКА --epsg: %s' % e, file=sys.stderr)
        return 2
    rep['source'] = {'epsg': src_epsg, 'kind': info['kind'], 'name': info['name'],
                     'wkt': wkt_for(src_epsg)}
    rep['bbox'] = [round(float(v), 3) for v in bbox]
    rep['corners_wgs84'] = bbox_corners_ll(bbox, src_epsg)
    # --- update-header: перезапись LAS с VLR (без пересчёта) ---
    if a.update_header:
        if H is None:
            print('ОШИБКА: --update-header только для LAS', file=sys.stderr); return 2
        out = a.out_las or (os.path.splitext(a.inp)[0] + '-crs.las')
        pts, rgbs = [], []
        total = 0
        for xyz, rgb in iter_las_chunks(a.inp, H):
            if a.max_points and total + len(xyz) > a.max_points:
                k = a.max_points - total
                xyz = xyz[:k]; rgb = rgb[:k] if rgb is not None else None
            total += len(xyz)
            pts.append(xyz)
            if rgb is not None:
                rgbs.append(rgb)
            if a.max_points and total >= a.max_points:
                break
        P = np.concatenate(pts) if pts else np.zeros((0, 3))
        RGB = np.concatenate(rgbs) if rgbs else None
        wi = write_las(out, P, RGB, wkt=rep['source']['wkt'], epsg=src_epsg)
        rep['update_header'] = wi
        rep['out_las'] = out
    # --- пересчёт ---
    if a.to:
        to = str(a.to).strip()
        if to.lower() in ('уск', 'usk', 'local', 'локальная', 'местная'):
            to_epsg = 0
        else:
            to_epsg = int(to)
        local_params = None
        if to_epsg == 0:
            if not a.local_params:
                print('ПРЕДУПРЕЖДЕНИЕ: --to local без --local-params — единичное преобразование',
                      file=sys.stderr)
                local_params = (0.0, 0.0, 0.0, 1.0)
            else:
                v = [float(x) for x in a.local_params.replace(';', ',').split(',')]
                if len(v) != 4:
                    print('ОШИБКА: --local-params E0,N0,theta_deg,scale', file=sys.stderr); return 2
                local_params = tuple(v)
        else:
            epsg_info(to_epsg)
        out = a.out_las or (os.path.splitext(a.inp)[0] + ('-epsg%d.las' % to_epsg))
        if H is None:
            # PLY → пересчитать точки и записать LAS
            P = np.asarray(P, dtype=np.float64)
            pts_t = _transform_points_np(P, src_epsg, to_epsg, local_params)
            wkt = wkt_for(to_epsg) if to_epsg else 'LOCAL_CS["USK/local",LOCAL_DATUM["local",0],UNIT["metre",1]]'
            wi = write_las(out, pts_t, None, wkt=wkt, epsg=to_epsg or None)
            rep['transform'] = {'points': len(pts_t), 'seconds': round(time.time() - t0, 2),
                                'bbox_after': [float(pts_t[:, 0].min()), float(pts_t[:, 1].min()),
                                               float(pts_t[:, 2].min()), float(pts_t[:, 0].max()),
                                               float(pts_t[:, 1].max()), float(pts_t[:, 2].max())]}
        else:
            rep['transform'] = transform_las(a.inp, to_epsg, out, src_epsg,
                                             a.max_points, local_params)
        rep['out_las'] = rep.get('out_las') or out
    # --- georef.json для IFC ---
    if a.georef_file:
        target = int(a.to) if (a.to and str(a.to).lower() not in ('уск', 'usk', 'local')) else src_epsg
        if epsg_info(target)['kind'] != 'projected':
            print('ОШИБКА: georef-file требует проекционную цель (UTM)', file=sys.stderr); return 2
        georef = {'schema': 'georef/1', 'ok': True,
                  'crs': {'epsg': target, 'wkt': wkt_for(target)},
                  'transform': {'mode': 'direct', 'rotation_deg': 0.0, 'scale': 1.0,
                                'translation': [0.0, 0.0, 0.0],
                                'ifc_map_conversion': {'eastings': 0.0, 'northings': 0.0,
                                                       'orthogonal_height': 0.0,
                                                       'x_axis_abscissa': 1.0,
                                                       'x_axis_ordinate': 0.0, 'scale': 1.0},
                                'source_transform': {'axis': 'zup', 't': [0.0, 0.0, 0.0]}},
                  'note': 'координаты LAS уже в целевой UTM; IFC = E,N,H напрямую'}
        os.makedirs(os.path.dirname(os.path.abspath(a.georef_file)) or '.', exist_ok=True)
        json.dump(georef, open(a.georef_file, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        rep['georef_file'] = a.georef_file
    rep['ok'] = True
    rep['elapsed_s'] = round(time.time() - t0, 2)
    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)) or '.', exist_ok=True)
        json.dump(rep, open(a.json, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        rep['json'] = a.json
    if not a.quiet:
        print('=== crs-tools: %s ===' % os.path.basename(a.inp))
        print('формат: %s | точек: %s | source EPSG:%d (%s)' % (
            rep['format'], rep.get('points_file'), src_epsg, info['name']))
        print('bbox:', rep['bbox'])
        if rep['corners_wgs84']:
            c = rep['corners_wgs84'][0]
            print('угол WGS84: lon %.8f, lat %.8f' % (c['lon'], c['lat']))
        if rep.get('vlr'):
            print('VLR:', rep['vlr'])
        if rep.get('update_header'):
            print('записан LAS с привязкой:', rep['out_las'], '(VLR %d)' % rep['update_header']['vlr'])
        if rep.get('transform'):
            tr = rep['transform']
            print('пересчёт → %s: точек %d, %.2f с' % (a.to, tr['points'], tr['seconds']))
            print('  bbox после:', [round(v, 3) for v in tr['bbox_after']])
        if rep.get('georef_file'):
            print('georef.json:', rep['georef_file'])
        print('время: %.2f с' % rep['elapsed_s'])
        if a.json:
            print('JSON:', os.path.abspath(a.json))
    return 0


def _transform_points_np(P, src_epsg, to_epsg, local_params=None):
    """Пересчёт массива (E,N,Z) → целевая система."""
    src = epsg_info(src_epsg)
    dst = epsg_info(to_epsg) if to_epsg else {'kind': 'local'}
    E, N, Z = P[:, 0], P[:, 1], P[:, 2]
    if src['kind'] == 'projected':
        tm_src = utm_of_epsg(src_epsg)
        lat, lon = _vec_ll(tm_src, E, N)
    else:
        lat, lon = N, E
    if dst['kind'] == 'projected':
        tm = utm_of_epsg(to_epsg)
        x, y = _vec_en(tm, lat, lon)
        return np.column_stack([x, y, Z])
    if dst['kind'] == 'geographic':
        return np.column_stack([lon, lat, Z])
    E0, N0, th, sc = local_params or (0.0, 0.0, 0.0, 1.0)
    th = math.radians(th)
    tm = tm_src if src['kind'] == 'projected' else TM('wgs84', 36, 'N')
    Ex, Nx = _vec_en(tm, lat, lon)
    x = ((Ex - E0) * math.cos(th) + (Nx - N0) * math.sin(th)) / sc
    y = (-(Ex - E0) * math.sin(th) + (Nx - N0) * math.cos(th)) / sc
    return np.column_stack([x, y, Z])


# ======================= публичные утилиты (для тестов/импорта) =======================
def utm_forward(lat, lon, zone=36, datum='wgs84', hemi='N'):
    tm = TM(datum, zone, hemi)
    return tm.forward(lat, lon)


def utm_inverse(E, N, zone=36, datum='wgs84', hemi='N'):
    tm = TM(datum, zone, hemi)
    return tm.inverse(E, N)


if __name__ == '__main__':
    sys.exit(main())


