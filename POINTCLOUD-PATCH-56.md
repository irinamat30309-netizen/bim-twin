# POINTCLOUD-PATCH-56 - Pro selection & floor/wall protection

Adds top-tier point-cloud editing to BIM Twin, focused on the #1 pain: separating
clutter from floors/walls without punching holes ("beam-through" fix).

## New capabilities
1. **RANSAC plane detection** (`detectPlanes`) - finds floor/ceiling/wall planes deterministically (seed 1337).
2. **Plane protection** (`protectPlanes` + viewer `setPlaneProtect`) - detected planes act as barriers: deletes and magic-wand never eat the floor/walls.
3. **Magic wand** (`magicWand`, click tool) - voxel-hash 26-connectivity flood-fill selects a connected object; protected planes stop the flood.
4. **Color pick / eyedropper** (`selectByColor`, click tool) - selects all points of a clicked color (auto 0..1 vs 0..255 scaling).
5. **Sphere / box selection** (`selectBySphere`, `selectByBox`) - geometric brush selection.
6. **Statistical Outlier Removal** (`cleanStatisticalOutliers`, SOR button) - CloudCompare/PCL-style kNN denoise; isolated points removed, undo-able.

## Files changed
- `renderer/pointcloud-edit.js` - 7 new pure functions + API export (node + window).
- `renderer/webgl-viewer.js` - setSelectMode wand/eyedrop; _applyEdit plane protection; new viewer methods (detectFloorWalls, setPlaneProtect, _pickIndex, magicWandAt, selectColorAt, selectSphere/At, selectBox, cleanSORInApp); click routing in mouseup/mousemove.
- `renderer/index.html` - 4 new toolbar buttons; asset version bump 1024->1025.
- `renderer/app.js` - button handlers wired to viewer.
- `test/pcedit-pro.test.js` - unit tests (node:test).

## Verification
- `node --check` on all 3 renderer files.
- `node --test test/pcedit-pro.test.js` (algorithmic core).
- GL runtime wiring is syntactically validated but not runtime-tested (no WebGL/GPU in sandbox).
