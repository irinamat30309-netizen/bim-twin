#!/usr/bin/env python3
"""Regenerate compact, fully synthetic LAZ parser fixtures.

Requires laspy 2.7.0 and lazrs 0.8.x. These are test-only tools; neither
package is an application/runtime dependency.
"""

from __future__ import annotations

import base64
from pathlib import Path

import laspy
import numpy as np


OUTPUT = Path(__file__).resolve().parent.parent / "test" / "fixtures"
WKT_32610 = (
    'PROJCRS["WGS 84 / UTM zone 10N",'
    'BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",'
    'ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]]],'
    'CONVERSION["UTM zone 10N",METHOD["Transverse Mercator"]],'
    'CS[Cartesian,2],AXIS["easting",east],AXIS["northing",north],'
    'LENGTHUNIT["metre",1],ID["EPSG",32610]]'
)


def make_fixture(name: str, version: str, point_format: int, count: int, *,
                 patterned: bool = False) -> None:
    header = laspy.LasHeader(point_format=point_format, version=version)
    header.scales = np.array([0.01, 0.01, 0.01])
    header.offsets = np.array([500_000.0, 6_000_000.0, 100.0])
    header.vlrs.append(
        laspy.VLR(
            user_id="LASF_Projection",
            record_id=2112,
            description="OGC WKT",
            record_data=WKT_32610.encode("utf-8") + b"\0",
        )
    )

    indices = np.arange(count, dtype=np.int64)
    las = laspy.LasData(header)
    las.x = 500_000.0 + (indices % 100) * 0.01
    las.y = 6_000_000.0 + ((indices // 100) % 100) * 0.01
    las.z = 100.0 + (indices % 10) * 0.01
    if patterned:
        las.intensity = (100 + (indices % 301)).astype(np.uint16)
        las.classification = (indices % 32).astype(np.uint8)
    else:
        las.intensity = np.array([100, 200, 300, 400], dtype=np.uint16)
        las.classification = np.array([2, 1, 2, 6], dtype=np.uint8)

    if point_format in (3, 8):
        if patterned:
            las.red = (indices % 256).astype(np.uint16) * 257
            las.green = ((indices * 7) % 256).astype(np.uint16) * 257
            las.blue = ((indices * 13) % 256).astype(np.uint16) * 257
        else:
            las.red = np.array([65535, 0, 0, 65535], dtype=np.uint16)
            las.green = np.array([0, 65535, 0, 65535], dtype=np.uint16)
            las.blue = np.array([0, 0, 65535, 65535], dtype=np.uint16)

    path = OUTPUT / name
    las.write(path, do_compress=True)
    sidecar = path.with_name(path.name + ".b64")
    sidecar.write_text(base64.b64encode(path.read_bytes()).decode("ascii") + "\n", encoding="ascii")
    print(f"{path.name}: {count} points, {path.stat().st_size} bytes")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    make_fixture("laz12-sample.laz", "1.2", 3, 4)
    make_fixture("laz14-sample.laz", "1.4", 8, 4)
    make_fixture("laz-decimation-200005.laz", "1.2", 3, 200_005, patterned=True)


if __name__ == "__main__":
    main()