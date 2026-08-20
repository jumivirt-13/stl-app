# .:petaktil 3D Printable Map — stl-export widget

An ArcGIS Experience Builder **custom widget** that converts a 3D scene inside a
user-drawn rectangle into a **binary STL file** ready for tactile 3D printing:
raised terrain, Braille labels, administrative boundary walls (dash-dot tactile
code), tsunami-hazard raster bands, disaster vector layers, and map-margin
furniture.

Live app: **https://jumivirt-13.github.io/stl-app/**

---

## What it does

- Draw a rectangle on a 3D scene → the widget builds a printable solid model of
  everything inside it.
- **Terrain** — real DEM surface (scene ground, falling back to World Terrain3D),
  optionally extruded to a watertight base.
- **Scene layers** — buildings and other 3D meshes, optionally simplified,
  clipped to the AOI, lifted onto the terrain, with foundation pads under
  floating buildings.
- **Administrative boundaries** — village/district/city/province/country walls as
  a tactile dash-dot code (village = dash + 4 dots … country = dash-dash),
  following the terrain surface.
- **Braille labels** — admin names rendered as raised 6-dot Braille on the map,
  plus furniture labels (title, scale, print scale) in the margin.
- **Hazard / disaster data** — raster contour bands with severity "texture"
  dots, and polygon / polyline / point disaster layers with per-class heights.
- **Roads & rivers** — raised wall lines / filled polygon areas.
- **Margin furniture** — title, scale bar (nice rounded distance), print scale,
  north arrow.
- **Output** — binary STL download + an in-widget 3D WebGL preview with orbit
  camera.

---

## Source layout

```
client/your-extensions/widgets/stl-export/src/
├── config.ts                     # config model & defaults
├── setting/setting.tsx           # widget settings panel
└── runtime/
    ├── widget.tsx                # 5-step wizard UI + runExport orchestration
    └── lib/
        ├── exportScene.ts        # main algorithm (~3800 lines)
        ├── writeStl.ts           # binary STL serialization + download
        └── preview3d.ts          # dependency-free WebGL preview renderer
```

The full widget source is mirrored in this repository under
[`src/`](src/):

| File | Size | Description |
|---|---|---|
| [`src/config.ts`](src/config.ts) | 11.6 KB | Config model & defaults (terrain, labels, admin levels, disaster classes, margins, layout) |
| [`src/runtime/widget.tsx`](src/runtime/widget.tsx) | 89.9 KB | 5-step wizard UI, AOI drawing, `runExport` orchestration, preview |
| [`src/runtime/lib/exportScene.ts`](src/runtime/lib/exportScene.ts) | 137.9 KB | Main algorithm: terrain, clipping, dash-dot walls, Braille, raster bands, STL mesh assembly |
| [`src/runtime/lib/writeStl.ts`](src/runtime/lib/writeStl.ts) | 3.4 KB | Binary STL serialization + browser download |
| [`src/runtime/lib/preview3d.ts`](src/runtime/lib/preview3d.ts) | 14 KB | Dependency-free WebGL preview renderer (WebGL2/1) |
| [`src/setting.tsx`](src/setting.tsx) | 35.9 KB | Widget settings panel (mirrors the config model) |
| [`src/manifest.json`](src/manifest.json) | 1.6 KB | Widget manifest (name, platform, dependencies) for Experience Builder |

## Architecture & data flow

```
widget.tsx (wizard UI)  →  exportScene(view, rectangle, config)  →  ExportResult
                                    │
              createTerrainMesh → querySceneLayerMeshes → liftBuildingsToTerrain
              → buildDivisionBoundaryWalls → buildLineFeatureWalls
              → buildRasterBands → buildDisasterVectorLayers → margin furniture
              → extrudeTerrain / buildFlatBase → merge → convertVertexSpace
                                    │
                          writeStl.meshToStl → binary STL Blob → download
                          extractPreviewGeometry → preview3d.Preview3D (WebGL)
```

The exporter is pure geometry code built on the ArcGIS JS API
(`esri/geometry/Mesh`, `meshUtils.createFromElevation`, `meshUtils.merge`,
`MeshLocalVertexSpace`) — no 3D engine is used to produce geometry.

---

## Key algorithms

| Area | Function | What it does |
|---|---|---|
| AOI drawing | `buildRectangleFromScreen` (widget.tsx) | Fixes tilted-camera foreshortening: anchors on the screen-centre ground point, measures ground m/pixel, rebuilds the AOI with the drawn on-screen aspect ratio |
| Terrain | `createTerrainMesh` | `meshUtils.createFromElevation` from the scene ground sampler; falls back to the online World Terrain3D ElevationLayer |
| Terrain lookup | `TerrainSampler` | Uniform-grid spatial index; inverse-distance-weighted height at (x, y); linear-scan fallback |
| Simplify | `simplifyMeshByClustering` | Vertex clustering to a 3D grid; each cell → centroid; drops degenerate triangles; shrinks dense Esri buildings |
| Clipping | `clipMeshToRectangle` | Sutherland–Hodgman half-space clip of each triangle; cap faces follow the real roof profile (stepped roofs) |
| Footprints | `buildingFootprintRings` | Rasterizes triangles into an occupancy grid and traces the boundary → robust closed rings |
| Division walls | `buildDivisionBoundaryWalls` / `buildDashDotWallFromRing` / `buildDashDotBlock` | Dash + N-dots pattern per admin level; blocks extruded along the terrain normal so side faces stand 90° to slopes |
| Braille | `buildBrailleLabelMesh` / `buildDomeMesh` | Standard 6-dot table (digits use the 3456 prefix); each dot is a rounded dome; labels placed to avoid walls and the AOI edge |
| Draped polygons | `buildDrapedPolygonArea` | Ear-clipped ring, adaptive subdivision to `(span/256)²` cells (depth ≤ 11); top follows terrain + height, bottom is a flat slab |
| Line walls | `buildDrapedLineWallsFromPaths` | Wall top/bottom follow the terrain profile; bottom embedded below the surface |
| Raster bands | `buildRasterBands` | `getSamples` on a grid; normalize → quantize into contour bands; slabs follow terrain; higher bands get larger "texture" dots |
| Disaster vectors | `buildDisasterVectorLayers` | One polygon/polyline/point layer each, recursing sublayers; per-class heights from an attribute field |
| STL | `meshToStl` (writeStl.ts) | Binary STL: 80-byte header, per-triangle normal + 3 vertices + attr; filters non-finite/huge vertices |
| Preview | `Preview3D` (preview3d.ts) | WebGL2/1 renderer: hand-written shaders, Lambert + edge darkening, orbit camera, smooth per-vertex normals |

---

## Unit conventions

All user-facing "mm on plate" values are converted to real ground meters by
`mmToMeters` using the AOI / print scale, so the printed model matches the
configured scale.

---

## Development notes

- Deployment: GitHub Pages (master + gh-pages branches serve the built app).
- Registered in ArcGIS Online as a **Web Mapping Application** item.
- The full per-file algorithm walkthrough lives in `DEVELOPMENT_SUMMARY.md`
  alongside the project source.