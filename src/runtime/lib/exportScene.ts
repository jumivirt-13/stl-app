import type SceneView from 'esri/views/SceneView'
import type Polygon from 'esri/geometry/Polygon'
import Mesh from 'esri/geometry/Mesh'
import Point from 'esri/geometry/Point'
import Polyline from 'esri/geometry/Polyline'
import Query from 'esri/rest/support/Query'
import ElevationLayer from 'esri/layers/ElevationLayer'
import geometryEngine from 'esri/geometry/geometryEngine'
import { createFromElevation, merge, convertVertexSpace } from 'esri/geometry/support/meshUtils'
import { projectOperator } from 'esri/geometry/operators/projectOperator'
import MeshLocalVertexSpace from 'esri/geometry/support/MeshLocalVertexSpace'
import { meshToStl } from './writeStl'
import type { Config, AdminLevelKey, AdminLevelWallConfig } from '../../config'
import { LAYER_SELECT_NONE, LINE_LAYER_NONE, DEFAULT_ADMIN_LEVELS, plateSizeMm } from '../../config'

export interface ExportResult {
  blob: Blob
  triangleCount: number
  layerCount: number
  includedTerrain: boolean
  preview: PreviewGeometry | null
}

/**
 * Lightweight triangle geometry (local meter space) returned for the live 3D
 * preview. Positions are x,y,z per vertex; indices group them into triangles.
 */
export interface PreviewGeometry {
  positions: Float32Array
  indices: Uint32Array
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

function isMeshGeometry(geometry: any): geometry is Mesh {
  return geometry && geometry.type === 'mesh'
}

function countTriangles(mesh: Mesh): number {
  const vertexCount = mesh.vertexAttributes.position.length / 3
  const components = mesh.components && mesh.components.length > 0
    ? mesh.components
    : [{ faces: null }]
  let count = 0
  for (const component of components) {
    const faces = component.faces
    count += faces && faces.length > 0 ? faces.length / 3 : vertexCount / 3
  }
  return Math.floor(count)
}

/**
 * Extracts a compact triangle geometry (local meter space) from a merged mesh
 * for the live 3D preview. Returns null if nothing usable is found.
 */
function extractPreviewGeometry(mesh: Mesh): PreviewGeometry | null {
  const raw = mesh.vertexAttributes.position
  const positions = raw instanceof Float32Array ? raw : new Float32Array(raw)
  const vertexCount = positions.length / 3
  if (vertexCount < 3) return null

  const components = mesh.components && mesh.components.length > 0
    ? mesh.components
    : [{ faces: null }]

  const indices: number[] = []
  for (const component of components) {
    const faces = component.faces
    if (faces && faces.length > 0) {
      for (let i = 0; i < faces.length; i += 3) {
        indices.push(faces[i], faces[i + 1], faces[i + 2])
      }
    } else {
      for (let i = 0; i < vertexCount; i += 3) {
        indices.push(i, i + 1, i + 2)
      }
    }
  }

  const finiteIndex = (idx: number) => {
    const x = positions[idx * 3]
    const y = positions[idx * 3 + 1]
    const z = positions[idx * 3 + 2]
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
      Math.abs(x) < 1e9 && Math.abs(y) < 1e9 && Math.abs(z) < 1e9
  }
  const valid = indices.filter((idx) => finiteIndex(idx))
  if (valid.length < 3) return null

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }

  return {
    positions,
    indices: new Uint32Array(valid),
    minX, minY, minZ, maxX, maxY, maxZ
  }
}

function hasValidPositions(mesh: Mesh): boolean {
  const attr = mesh.vertexAttributes.position
  if (!attr || attr.length < 3) return false
  for (let i = 0; i < attr.length; i++) {
    const v = attr[i]
    if (!Number.isFinite(v) || Math.abs(v) > 1e9) return false
  }
  return true
}

function sanitizeTerrain(mesh: Mesh): Mesh {
  const attr = mesh.vertexAttributes.position
  const out = new Float32Array(attr.length)
  for (let i = 0; i < attr.length; i++) {
    const v = attr[i]
    out[i] = (Number.isFinite(v) && Math.abs(v) < 1e9) ? v : 0
  }
  return new Mesh({
    vertexAttributes: { position: out },
    components: mesh.components,
    spatialReference: mesh.spatialReference
  })
}

function translateTerrain(mesh: Mesh, dz: number): Mesh {
  const attr = mesh.vertexAttributes.position
  const out = new Float32Array(attr.length)
  for (let i = 0; i < attr.length; i += 3) {
    out[i] = attr[i]
    out[i + 1] = attr[i + 1]
    out[i + 2] = attr[i + 2] + dz
  }
  return new Mesh({
    vertexAttributes: { position: out },
    components: mesh.components,
    spatialReference: mesh.spatialReference
  })
}

function minZOf(mesh: Mesh): number {
  const attr = mesh.vertexAttributes.position
  let m = Infinity
  for (let i = 2; i < attr.length; i += 3) {
    if (attr[i] < m) m = attr[i]
  }
  return m
}

function minZOfAll(meshes: Mesh[]): number {
  let m = Infinity
  for (const mesh of meshes) {
    const v = minZOf(mesh)
    if (v < m) m = v
  }
  return m
}

/**
 * Samples the DEM height at a given WebMercator coordinate by finding the
 * nearest terrain mesh vertex.
 */
function terrainHeightAt(terrain: Mesh, x: number, y: number): number | null {
  const attr = terrain.vertexAttributes.position
  let best = Infinity
  let bestZ = 0
  let found = false
  for (let i = 0; i < attr.length; i += 3) {
    const dx = attr[i] - x
    const dy = attr[i + 1] - y
    const d2 = dx * dx + dy * dy
    if (d2 < best) {
      best = d2
      bestZ = attr[i + 2]
      found = true
    }
  }
  return found ? bestZ : null
}

/**
 * A spatial index over a terrain mesh that answers "height at (x, y)" quickly.
 * Terrain vertices are bucketed into a uniform grid; sampling looks only in the
 * cell containing the query point (plus a small margin) instead of scanning the
 * whole mesh. Falls back to a linear scan when the grid is degenerate.
 */
class TerrainSampler {
  private positions: Float64Array | Float32Array
  private cellSize: number
  private gridX0: number
  private gridY0: number
  private cols: number
  private rows: number
  private buckets: number[][]
  private linear: boolean

  constructor(terrain: Mesh) {
    const attr = terrain.vertexAttributes.position
    this.positions = attr
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let n = 0
    for (let i = 0; i < attr.length; i += 3) {
      const x = attr[i], y = attr[i + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      n++
    }
    if (n === 0 || maxX === minX || maxY === minY) {
      this.cellSize = 1
      this.gridX0 = 0
      this.gridY0 = 0
      this.cols = 1
      this.rows = 1
      this.buckets = []
      this.linear = true
      return
    }
    const side = Math.max(16, Math.ceil(Math.sqrt(n) / 2))
    this.cellSize = Math.max((maxX - minX) / side, (maxY - minY) / side, 1e-6)
    this.gridX0 = minX
    this.gridY0 = minY
    this.cols = Math.ceil((maxX - minX) / this.cellSize) + 1
    this.rows = Math.ceil((maxY - minY) / this.cellSize) + 1
    this.buckets = []
    for (let c = 0; c < this.cols * this.rows; c++) this.buckets.push([])
    for (let i = 0; i < attr.length; i += 3) {
      const x = attr[i], y = attr[i + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const ci = Math.floor((x - minX) / this.cellSize)
      const ri = Math.floor((y - minY) / this.cellSize)
      const idx = ri * this.cols + ci
      if (idx >= 0 && idx < this.buckets.length) {
        this.buckets[idx].push(i)
      }
    }
    this.linear = false
  }

  get getCellSize(): number {
    return this.cellSize
  }

  heightAt(x: number, y: number): number | null {
    if (this.linear) return terrainHeightAtLinear(this.positions, x, y)
    const ci0 = Math.floor((x - this.gridX0) / this.cellSize)
    const ri0 = Math.floor((y - this.gridY0) / this.cellSize)
    let wSum = 0
    let zSum = 0
    let found = false
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const ci = ci0 + dc
        const ri = ri0 + dr
        if (ci < 0 || ri < 0 || ci >= this.cols || ri >= this.rows) continue
        const bucket = this.buckets[ri * this.cols + ci]
        for (const i of bucket) {
          const dx = this.positions[i] - x
          const dy = this.positions[i + 1] - y
          const d2 = dx * dx + dy * dy
          const w = 1 / (d2 + 1e-9)
          wSum += w
          zSum += w * this.positions[i + 2]
          found = true
        }
      }
    }
    return found ? zSum / wSum : null
  }
}

function terrainHeightAtLinear(attr: Float64Array | Float32Array, x: number, y: number): number | null {
  let best = Infinity
  let bestZ = 0
  let found = false
  for (let i = 0; i < attr.length; i += 3) {
    const dx = attr[i] - x
    const dy = attr[i + 1] - y
    const d2 = dx * dx + dy * dy
    if (d2 < best) {
      best = d2
      bestZ = attr[i + 2]
      found = true
    }
  }
  return found ? bestZ : null
}

/**
 * Vertically translates every building mesh so its base sits on the DEM
 * surface at the building's footprint center. The scene (OSM 3D style) places
 * buildings on a flat ground (z ~ 0), while the world DEM uses absolute
 * ellipsoidal heights, so without this the buildings would float below or
 * above the terrain.
 */
function liftBuildingsToTerrain(buildings: Mesh[], terrain: Mesh): void {
  let lifted = 0
  for (const building of buildings) {
    const ext = building.extent
    if (!ext) continue
    const cx = (ext.xmin + ext.xmax) / 2
    const cy = (ext.ymin + ext.ymax) / 2
    const surface = terrainHeightAt(terrain, cx, cy)
    if (surface === null) continue
    const base = minZOf(building)
    const dz = surface - base
    if (Math.abs(dz) < 1e-6) continue
    const attr = building.vertexAttributes.position
    for (let i = 2; i < attr.length; i += 3) {
      attr[i] += dz
    }
    lifted++
  }
  console.log('[stl-export] lifted buildings to terrain:', lifted)
}

/**
 * Reduces the triangle count of a mesh by clustering vertices into a 3D grid
 * of the given cell size. Vertices that fall into the same cell are replaced by
 * their average position, and degenerate triangles are removed. This keeps the
 * overall form, orientation and size while dramatically shrinking dense meshes
 * (e.g. Esri 3D Buildings).
 */
function simplifyMeshByClustering(mesh: Mesh, tol: number): Mesh {
  if (!tol || tol <= 0) return mesh
  const positions = mesh.vertexAttributes.position
  const vertexCount = positions.length / 3
  if (vertexCount === 0) return mesh
  const components = mesh.components && mesh.components.length > 0
    ? mesh.components
    : [{ faces: null }]

  const triangles: number[][] = []
  for (const component of components) {
    const faces = component.faces
    if (faces && faces.length > 0) {
      for (let i = 0; i + 2 < faces.length; i += 3) {
        triangles.push([faces[i], faces[i + 1], faces[i + 2]])
      }
    } else {
      for (let i = 0; i + 2 < vertexCount; i += 3) {
        triangles.push([i, i + 1, i + 2])
      }
    }
  }

  const cellKey = (idx: number): string => {
    const gx = Math.round(positions[idx * 3] / tol)
    const gy = Math.round(positions[idx * 3 + 1] / tol)
    const gz = Math.round(positions[idx * 3 + 2] / tol)
    return gx + '_' + gy + '_' + gz
  }

  const sums = new Map<string, { sx: number, sy: number, sz: number, n: number }>()
  for (let i = 0; i < vertexCount; i++) {
    const key = cellKey(i)
    const s = sums.get(key) || { sx: 0, sy: 0, sz: 0, n: 0 }
    s.sx += positions[i * 3]
    s.sy += positions[i * 3 + 1]
    s.sz += positions[i * 3 + 2]
    s.n++
    sums.set(key, s)
  }

  const clusterIndex = new Map<string, number>()
  const newPositions: number[] = []
  for (const [key, s] of sums) {
    clusterIndex.set(key, newPositions.length / 3)
    newPositions.push(s.sx / s.n, s.sy / s.n, s.sz / s.n)
  }

  const newFaces: number[] = []
  for (const t of triangles) {
    const a = clusterIndex.get(cellKey(t[0]))
    const b = clusterIndex.get(cellKey(t[1]))
    const c = clusterIndex.get(cellKey(t[2]))
    if (a === undefined || b === undefined || c === undefined) continue
    if (a === b || b === c || a === c) continue
    newFaces.push(a, b, c)
  }

  if (newFaces.length === 0) return mesh
  return new Mesh({
    vertexAttributes: { position: new Float64Array(newPositions) },
    components: [{ faces: newFaces }],
    spatialReference: mesh.spatialReference
  })
}

/**
 * Extracts the closed 2D outline ring(s) of a solid mesh by rasterizing the
 * projected XY triangles into an occupancy grid and tracing the boundary of the
 * filled region. This is robust to overlapping wall/roof edges at different
 * heights, which the 3D-edge-counting approach miscounts.
 */
function buildingFootprintRings(mesh: Mesh, cell: number): Array<Array<[number, number]>> {
  const positions = mesh.vertexAttributes.position
  const vertexCount = positions.length / 3
  const components = mesh.components && mesh.components.length > 0
    ? mesh.components
    : [{ faces: null }]

  const triangles: number[][] = []
  for (const component of components) {
    const faces = component.faces
    if (faces && faces.length > 0) {
      for (let i = 0; i + 2 < faces.length; i += 3) {
        triangles.push([faces[i], faces[i + 1], faces[i + 2]])
      }
    } else {
      for (let i = 0; i + 2 < vertexCount; i += 3) {
        triangles.push([i, i + 1, i + 2])
      }
    }
  }
  if (triangles.length === 0) return []

  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    if (x < xmin) xmin = x
    if (y < ymin) ymin = y
    if (x > xmax) xmax = x
    if (y > ymax) ymax = y
  }
  const w = Math.max(xmax - xmin, 1e-6)
  const h = Math.max(ymax - ymin, 1e-6)
  const gridW = Math.max(16, Math.min(256, Math.ceil(w / cell)))
  const gridH = Math.max(16, Math.min(256, Math.ceil(h / cell)))
  const cx = w / gridW
  const cy = h / gridH

  const occupied = new Uint8Array(gridW * gridH)

  const pointInTri = (px: number, py: number, ax: number, ay: number, bx: number, by: number, cxx: number, cyy: number): boolean => {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    const d2 = (px - cxx) * (by - cyy) - (bx - cxx) * (py - cyy)
    const d3 = (px - ax) * (cyy - ay) - (cxx - ax) * (py - ay)
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0)
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0)
    return !(hasNeg && hasPos)
  }

  for (const t of triangles) {
    const ax = positions[t[0] * 3]
    const ay = positions[t[0] * 3 + 1]
    const bx = positions[t[1] * 3]
    const by = positions[t[1] * 3 + 1]
    const cxx = positions[t[2] * 3]
    const cyy = positions[t[2] * 3 + 1]
    let txmin = Math.min(ax, bx, cxx), tymin = Math.min(ay, by, cyy)
    let txmax = Math.max(ax, bx, cxx), tymax = Math.max(ay, by, cyy)
    const i0 = Math.max(0, Math.floor((txmin - xmin) / cx))
    const i1 = Math.min(gridW - 1, Math.floor((txmax - xmin) / cx))
    const j0 = Math.max(0, Math.floor((tymin - ymin) / cy))
    const j1 = Math.min(gridH - 1, Math.floor((tymax - ymin) / cy))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = xmin + (i + 0.5) * cx
        const py = ymin + (j + 0.5) * cy
        if (occupied[j * gridW + i]) continue
        if (pointInTri(px, py, ax, ay, bx, by, cxx, cyy)) occupied[j * gridW + i] = 1
      }
    }
  }

  // Boundary edges: each occupied cell's edges that border an empty cell.
  // Corner coordinate helpers.
  const cornerX = (i: number): number => xmin + i * cx
  const cornerY = (j: number): number => ymin + j * cy
  const isFilled = (i: number, j: number): boolean => {
    if (i < 0 || i >= gridW || j < 0 || j >= gridH) return false
    return occupied[j * gridW + i] === 1
  }

  type Corner = [number, number]
  const adj = new Map<string, Array<{ other: string, x: number, y: number, edgeKey: string }>>()
  const cornerKey = (i: number, j: number): string => i + '_' + j
  const addEdge = (a: Corner, b: Corner) => {
    const ka = cornerKey(a[0], a[1])
    const kb = cornerKey(b[0], b[1])
    const eKey = ka < kb ? ka + '|' + kb : kb + '|' + ka
    const add = (from: string, to: Corner) => {
      const list = adj.get(from) || []
      list.push({ other: cornerKey(to[0], to[1]), x: cornerX(to[0]), y: cornerY(to[1]), edgeKey: eKey })
      adj.set(from, list)
    }
    add(ka, b)
    add(kb, a)
  }

  for (let j = 0; j < gridH; j++) {
    for (let i = 0; i < gridW; i++) {
      if (!isFilled(i, j)) continue
      if (!isFilled(i, j + 1)) addEdge([i, j + 1], [i + 1, j + 1])
      if (!isFilled(i, j - 1)) addEdge([i, j], [i + 1, j])
      if (!isFilled(i + 1, j)) addEdge([i + 1, j], [i + 1, j + 1])
      if (!isFilled(i - 1, j)) addEdge([i, j], [i, j + 1])
    }
  }

  const usedEdges = new Set<string>()
  const rings: Array<Array<[number, number]>> = []
  for (const [startKey, nbrs] of adj) {
    if (nbrs.length === 0) continue
    for (const nb of nbrs) {
      if (usedEdges.has(nb.edgeKey)) continue
      const ring: Array<[number, number]> = []
      let prev = startKey
      let cur = nb
      usedEdges.add(nb.edgeKey)
      ring.push([nb.x, nb.y])
      let guard = 0
      const maxSteps = 200000
      while (guard < maxSteps) {
        const curList = adj.get(cur.other) || []
        let next: { other: string, x: number, y: number, edgeKey: string } | null = null
        for (const cand of curList) {
          if (cand.other === prev) continue
          if (usedEdges.has(cand.edgeKey)) continue
          next = cand
          break
        }
        if (!next) break
        usedEdges.add(next.edgeKey)
        ring.push([next.x, next.y])
        prev = cur.other
        cur = next
        guard++
        if (next.other === startKey) break
      }
      if (ring.length >= 3) rings.push(ring)
    }
  }

  return rings.map(simplifyRing)
}

/**
 * Removes near-collinear vertices from a closed ring to keep the pad geometry
 * compact.
 */
function simplifyRing(ring: Array<[number, number]>): Array<[number, number]> {
  if (ring.length <= 4) return ring
  const out: Array<[number, number]> = []
  const eps = 1e-6
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const a = ring[(i - 1 + ring.length) % ring.length]
    const b = ring[(i + 1) % ring.length]
    const cross = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
    const len = Math.max(1e-12, Math.hypot(b[0] - a[0], b[1] - a[1]))
    if (Math.abs(cross) / len > eps) out.push(p)
  }
  if (out.length < 3) return ring
  return out
}

/**
 * Builds a solid rectangular prism (foundation pad) spanning the given XY
 * footprint between two Z levels. Used to pin a flying building down to the
 * ground surface.
 */
function rectPrismMesh(
  x0: number, y0: number, x1: number, y1: number,
  topZ: number, bottomZ: number,
  spatialReference: any
): Mesh {
  const pos = new Float64Array(8 * 3)
  const v = (i: number, x: number, y: number, z: number) => {
    pos[i * 3] = x
    pos[i * 3 + 1] = y
    pos[i * 3 + 2] = z
  }
  v(0, x0, y0, topZ)
  v(1, x1, y0, topZ)
  v(2, x1, y1, topZ)
  v(3, x0, y1, topZ)
  v(4, x0, y0, bottomZ)
  v(5, x1, y0, bottomZ)
  v(6, x1, y1, bottomZ)
  v(7, x0, y1, bottomZ)

  const faces = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7
  ]

  return new Mesh({
    vertexAttributes: { position: pos },
    components: [{ faces }],
    spatialReference
  })
}

/**
 * Adds a foundation pad beneath any building whose base is still floating
 * above the terrain (e.g. buildings that could not be lifted because the
 * terrain could not be sampled under them, or that were authored in
 * absolute altitude mode). The pad spans the building's XY footprint and runs
 * from the building base down to the terrain surface, guaranteeing contact.
 * Appends pad meshes to the `out` array and returns the number added.
 */
function addFoundationPads(buildings: Mesh[], terrain: Mesh, out: Mesh[]): number {
  let pads = 0
  const sr = terrain.spatialReference
  for (const building of buildings) {
    const ext = building.extent
    if (!ext) continue
    const base = minZOf(building)
    const cx = (ext.xmin + ext.xmax) / 2
    const cy = (ext.ymin + ext.ymax) / 2

    const quantization = Math.max(0.05, Math.max(ext.width, ext.height) / 256)
    const rings = buildingFootprintRings(building, quantization)
    const ringPoints: Array<[number, number]> = []
    let ringArea = 0
    if (rings.length > 0) {
      for (const ring of rings) {
        for (const p of ring) ringPoints.push([p[0], p[1]])
      }
      let largest = rings[0]
      for (const ring of rings) {
        if (Math.abs(signedArea2D(ring)) > Math.abs(signedArea2D(largest))) largest = ring
      }
      ringArea = Math.abs(signedArea2D(largest))
    }
    if (ringPoints.length === 0) {
      ringPoints.push([cx, cy], [ext.xmin, ext.ymin], [ext.xmax, ext.ymin], [ext.xmin, ext.ymax], [ext.xmax, ext.ymax], [cx, ext.ymin], [cx, ext.ymax], [ext.xmin, cy], [ext.xmax, cy])
    }

    const samples: Array<[number, number]> = ringPoints
    let tMin = Infinity
    let found = false
    for (const [sx, sy] of samples) {
      const z = terrainHeightAt(terrain, sx, sy)
      if (z === null) continue
      if (z < tMin) tMin = z
      found = true
    }
    if (!found || !Number.isFinite(tMin)) continue
    // Building is already seated at or below the lowest sampled ground point.
    if (base <= tMin + 0.01) continue

    // Fall back to the bounding box when the footprint extraction fails.
    if (rings.length === 0 || ringArea < 1e-4) {
      out.push(rectPrismMesh(ext.xmin, ext.ymin, ext.xmax, ext.ymax, base, tMin - 0.01, sr))
      pads++
      continue
    }

    for (const ring of rings) {
      const pad = buildRingSlab([ring], tMin - 0.01, base, sr)
      if (pad) out.push(pad)
    }
    pads++
  }
  return pads
}

/**
 * Creates a terrain (elevation) mesh for the given extent by sampling the
 * scene ground. Falls back to the global World Terrain3D service when the
 * scene ground has no elevation data (e.g. the flat OSM 3D style).
 */
async function createTerrainMesh(view: SceneView, extent: any): Promise<Mesh | null> {
  const sampler = view.groundView?.elevationSampler
  if (sampler) {
    try {
      const mesh = await createFromElevation(sampler, extent)
      if (mesh && hasRealElevation(mesh)) return mesh
      console.warn('[stl-export] scene ground has no elevation data, falling back to World Terrain3D')
    } catch (e) {
      console.warn('[stl-export] Terrain mesh creation from scene ground failed', e)
    }
  } else {
    console.warn('[stl-export] no scene ground sampler, using World Terrain3D')
  }

  try {
    const worldTerrain = new ElevationLayer({
      url: 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'
    })
    await worldTerrain.load()
    return await createFromElevation(worldTerrain, extent)
  } catch (e) {
    console.warn('[stl-export] World Terrain3D fallback failed', e)
    return null
  }
}

function hasRealElevation(mesh: Mesh): boolean {
  const attr = mesh.vertexAttributes.position
  if (!attr || attr.length < 3) return false
  for (let i = 2; i < attr.length; i += 3) {
    const z = attr[i]
    if (Number.isFinite(z) && Math.abs(z) < 1e9) return true
  }
  return false
}

type Vec3 = [number, number, number]

function clipPolygonToHalfspace(
  polygon: Vec3[],
  axis: 0 | 1,
  minOrMax: 'min' | 'max',
  boundary: number
): Vec3[] {
  const output: Vec3[] = []
  const n = polygon.length
  for (let i = 0; i < n; i++) {
    const current = polygon[i]
    const next = polygon[(i + 1) % n]
    const currentInside = minOrMax === 'min' ? current[axis] >= boundary : current[axis] <= boundary
    const nextInside = minOrMax === 'min' ? next[axis] >= boundary : next[axis] <= boundary
    if (currentInside !== nextInside) {
      const t = (boundary - current[axis]) / (next[axis] - current[axis])
      const point: Vec3 = [
        current[0] + (next[0] - current[0]) * t,
        current[1] + (next[1] - current[1]) * t,
        current[2] + (next[2] - current[2]) * t
      ]
      point[axis] = boundary
      output.push(point)
    }
    if (nextInside) {
      output.push(next)
    }
  }
  return output
}

function clipTriangleToExtent(triangle: Vec3[], extent: any): Vec3[][] {
  let polygon = triangle
  polygon = clipPolygonToHalfspace(polygon, 0, 'min', extent.xmin)
  polygon = clipPolygonToHalfspace(polygon, 0, 'max', extent.xmax)
  polygon = clipPolygonToHalfspace(polygon, 1, 'min', extent.ymin)
  polygon = clipPolygonToHalfspace(polygon, 1, 'max', extent.ymax)
  if (polygon.length < 3) {
    return []
  }
  const triangles: Vec3[][] = []
  for (let i = 1; i < polygon.length - 1; i++) {
    triangles.push([polygon[0], polygon[i], polygon[i + 1]])
  }
  return triangles
}

/**
 * Clips a triangle against the rectangle extent (same as clipTriangleToExtent)
 * and also captures the cut segments that lie exactly on each of the four
 * rectangle planes. These segments trace the exposed cross-section outline of
 * the cut, so the cap can follow the building's actual roof profile (including
 * stepped roofs). Segments from triangles coplanar with a plane are excluded so
 * interior walls coincident with the cut plane do not pollute the outline.
 */
function clipTriangleToExtentPlaneSegments(
  triangle: Vec3[],
  extent: any,
  tol: number
): { triangles: Vec3[][]; segments: Vec3[][][] } {
  let polygon = triangle
  polygon = clipPolygonToHalfspace(polygon, 0, 'min', extent.xmin)
  polygon = clipPolygonToHalfspace(polygon, 0, 'max', extent.xmax)
  polygon = clipPolygonToHalfspace(polygon, 1, 'min', extent.ymin)
  polygon = clipPolygonToHalfspace(polygon, 1, 'max', extent.ymax)

  const segments: Vec3[][][] = [[], [], [], []]
  if (polygon.length < 3) {
    return { triangles: [], segments }
  }

  const planes: Array<{ axis: 0 | 1; boundary: number }> = [
    { axis: 0, boundary: extent.xmin },
    { axis: 0, boundary: extent.xmax },
    { axis: 1, boundary: extent.ymin },
    { axis: 1, boundary: extent.ymax }
  ]
  const onPlane = (v: Vec3, p: { axis: 0 | 1; boundary: number }): boolean =>
    Math.abs(v[p.axis] - p.boundary) <= tol

  for (let pi = 0; pi < planes.length; pi++) {
    const p = planes[pi]
    if (polygon.every((v) => onPlane(v, p))) continue
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]
      const b = polygon[(i + 1) % polygon.length]
      if (onPlane(a, p) && onPlane(b, p)) {
        segments[pi].push([a.slice() as Vec3, b.slice() as Vec3])
      }
    }
  }

  const triangles: Vec3[][] = []
  for (let i = 1; i < polygon.length - 1; i++) {
    triangles.push([polygon[0], polygon[i], polygon[i + 1]])
  }
  return { triangles, segments }
}

function edgeKeyTwo(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function signedArea2D(points: Array<[number, number]>): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    area += points[i][0] * points[j][1] - points[j][0] * points[i][1]
  }
  return area / 2
}

/**
 * Tests whether a 2D point is inside a polygon ring (ray casting). Points on
 * the boundary are treated as inside.
 */
function pointInRing2D(x: number, y: number, ring: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Tests whether a 2D point is inside a polygon consisting of multiple rings
 * (first ring = outer boundary, following rings = holes). A point is inside if
 * it is inside the outer ring and not inside any hole ring.
 */
function pointInRings2D(x: number, y: number, rings: Array<Array<[number, number]>>): boolean {
  if (rings.length === 0) return false
  if (!pointInRing2D(x, y, rings[0])) return false
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing2D(x, y, rings[k])) return false
  }
  return true
}

/**
 * Triangulates a simple polygon given as 2D points. Returns a list of
 * triangles expressed as indices into the input array (ear clipping).
 */
function earClip2D(points: Array<[number, number]>): number[][] {
  const n = points.length
  if (n < 3) return []
  const ccw = signedArea2D(points) >= 0
  const cross = (o: number, a: number, b: number): number => {
    return (
      (points[a][0] - points[o][0]) * (points[b][1] - points[o][1]) -
      (points[a][1] - points[o][1]) * (points[b][0] - points[o][0])
    )
  }
  const pointInTri = (p: number, a: number, b: number, c: number): boolean => {
    const d1 = cross(a, b, p)
    const d2 = cross(b, c, p)
    const d3 = cross(c, a, p)
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0
    return !(hasNeg && hasPos)
  }

  const indices = points.map((_, i) => i)
  const triangles: number[][] = []
  let guard = 0
  while (indices.length > 3 && guard++ < 100000) {
    let earFound = false
    for (let i = 0; i < indices.length && !earFound; i++) {
      const a = indices[(i - 1 + indices.length) % indices.length]
      const b = indices[i]
      const c = indices[(i + 1) % indices.length]
      const cr = cross(a, b, c)
      if (ccw ? cr <= 0 : cr >= 0) continue
      let inside = false
      for (const p of indices) {
        if (p === a || p === b || p === c) continue
        if (pointInTri(p, a, b, c)) {
          inside = true
          break
        }
      }
      if (inside) continue
      triangles.push([a, b, c])
      indices.splice(i, 1)
      earFound = true
    }
    if (!earFound) {
      for (let i = 1; i < indices.length - 1; i++) {
        triangles.push([indices[0], indices[i], indices[i + 1]])
      }
      break
    }
  }
  if (indices.length === 3) {
    triangles.push([indices[0], indices[1], indices[2]])
  }
  return triangles
}

function triNormal(pa: Vec3, pb: Vec3, pc: Vec3): Vec3 {
  const ax = pb[0] - pa[0]
  const ay = pb[1] - pa[1]
  const az = pb[2] - pa[2]
  const bx = pc[0] - pa[0]
  const by = pc[1] - pa[1]
  const bz = pc[2] - pa[2]
  return [
    ay * bz - az * by,
    az * bx - ax * bz,
    ax * by - ay * bx
  ]
}

/**
 * Vertex on a cap plane from a 2D (other-axis, z) point pair. The rectangle
 * axis coordinate is fixed to the plane boundary.
 */
function vert(
  plane: { axis: 0 | 1; boundary: number },
  p: Array<number>,
  other: 0 | 1
): Vec3 {
  return plane.axis === 0
    ? [plane.boundary, p[0], p[1]]
    : [p[0], plane.boundary, p[1]]
}

/**
 * Closes the exposed cross-sections of a mesh that was clipped against the four
 * vertical planes of the rectangle extent. For each plane, the captured cut
 * segments are chained into closed loops in 2D (other-axis, z), each loop is
 * ear-clipped, and cap faces are appended so the cut face follows the building's
 * actual silhouette (including stepped roofs). Cap normals point away from the
 * rectangle interior.
 */
function addCapFaces(
  positions: number[],
  faces: number[],
  extent: any,
  planeSegments: Vec3[][][]
): void {
  const planes: Array<{ axis: 0 | 1; boundary: number; sign: 1 | -1 }> = [
    { axis: 0, boundary: extent.xmin, sign: -1 },
    { axis: 0, boundary: extent.xmax, sign: 1 },
    { axis: 1, boundary: extent.ymin, sign: -1 },
    { axis: 1, boundary: extent.ymax, sign: 1 }
  ]
  const tol = Math.max(1e-6, (extent.width + extent.height) * 1e-9)
  const q2 = (x: number, y: number): string => `${x.toFixed(4)}_${y.toFixed(4)}`

  let globalZMin = Infinity
  let globalZMax = -Infinity
  for (let i = 0; i < positions.length / 3; i++) {
    const z = positions[i * 3 + 2]
    if (z < globalZMin) globalZMin = z
    if (z > globalZMax) globalZMax = z
  }

  const pushVert = (v: Vec3): number => {
    const i = positions.length / 3
    positions.push(v[0], v[1], v[2])
    return i
  }
  const orientPush = (va: Vec3, vb: Vec3, vc: Vec3, plane: { axis: 0 | 1; sign: 1 | -1 }): void => {
    let i0 = pushVert(va)
    let i1 = pushVert(vb)
    let i2 = pushVert(vc)
    const n = triNormal(va, vb, vc)
    if (n[plane.axis] * plane.sign < 0) {
      const tmp = i1
      i1 = i2
      i2 = tmp
    }
    faces.push(i0, i1, i2)
  }

  for (let pi = 0; pi < planes.length; pi++) {
    const plane = planes[pi]
    const segs = planeSegments[pi]
    const other: 0 | 1 = plane.axis === 0 ? 1 : 0

    // ------------------------------------------------------------------
    // Gather the actual cut footprint: all vertices of the clipped mesh
    // that lie on this plane, plus their z-range. This is authoritative:
    // any plane that cut through the building must have at least one such
    // vertex, and its bounds tell us the rectangle we must seal.
    // ------------------------------------------------------------------
    let oMin = Infinity
    let oMax = -Infinity
    let zMin = Infinity
    let zMax = -Infinity
    let count = 0
    for (let i = 0; i < positions.length / 3; i++) {
      if (Math.abs(positions[i * 3 + plane.axis] - plane.boundary) > tol) continue
      const o = positions[i * 3 + other]
      const z = positions[i * 3 + 2]
      if (o < oMin) oMin = o
      if (o > oMax) oMax = o
      if (z < zMin) zMin = z
      if (z > zMax) zMax = z
      count++
    }

    // Plane genuinely cut this building only if we have on-plane vertices
    // or captured cut segments. Otherwise this plane does not touch the
    // building and needs no cap.
    if (count === 0 && segs.length === 0) continue

    // Try the silhouette first: chain the captured cut segments into loops
    // (2D in other-axis/z) and ear-clip them so stepped roofs are preserved.
    let capsPushed = 0

    if (segs.length >= 3 && count >= 3) {
      const adj = new Map<string, Vec3[]>()
      const keyOf = (v: Vec3): string => q2(plane.axis === 0 ? v[1] : v[0], v[2])
      const seenSeg = new Set<string>()
      for (const [a, b] of segs) {
        const ka = keyOf(a)
        const kb = keyOf(b)
        const ek = edgeKeyTwo(ka, kb)
        if (seenSeg.has(ek)) continue
        seenSeg.add(ek)
        if (!adj.has(ka)) adj.set(ka, [])
        if (!adj.has(kb)) adj.set(kb, [])
        adj.get(ka)!.push(b)
        adj.get(kb)!.push(a)
      }

      const used = new Set<string>()
      const seen = new Set<string>()
      const chains: Array<{ pts: Array<[number, number]>; closed: boolean }> = []
      for (const [startKey] of adj) {
        if (seen.has(startKey)) continue
        const loopKeys: string[] = [startKey]
        let cur = startKey
        let prev: string | null = null
        let guard = 0
        while (guard++ < 100000) {
          const nbrs = adj.get(cur) || []
          let found: string | null = null
          for (const v of nbrs) {
            const k = keyOf(v)
            if (k === prev) continue
            if (used.has(edgeKeyTwo(cur, k))) continue
            found = k
            break
          }
          if (!found) break
          used.add(edgeKeyTwo(cur, found))
          loopKeys.push(found)
          for (const k of loopKeys) seen.add(k)
          prev = cur
          cur = found
          if (found === startKey) break
        }
        if (loopKeys.length < 3) continue
        const pts: Array<[number, number]> = loopKeys
          .map((k) => k.split('_').map(Number) as [number, number])
        chains.push({ pts, closed: loopKeys[loopKeys.length - 1] === startKey })
      }

      let coveredOMin = Infinity
      let coveredOMax = -Infinity
      const sealedPolys: Array<Array<[number, number]>> = []
      for (const chain of chains) {
        const pts = chain.closed ? chain.pts.slice(0, -1) : chain.pts
        if (pts.length < 3) continue
        let poly: Array<[number, number]>
        if (chain.closed) {
          const area = Math.abs(signedArea2D(pts))
          if (area < tol * tol) continue
          poly = pts
        } else {
          // Open chain: close it along the building base so the cap fills the
          // exposed cross-section even when the building has no floor face.
          const first = pts[0]
          const last = pts[pts.length - 1]
          poly = [...pts, [last[0], globalZMin], [first[0], globalZMin]]
          const area = Math.abs(signedArea2D(poly))
          if (area < tol * tol) continue
        }
        for (const p of poly) {
          if (p[0] < coveredOMin) coveredOMin = p[0]
          if (p[0] > coveredOMax) coveredOMax = p[0]
        }
        sealedPolys.push(poly)
      }

      // Trust the silhouette caps only if they reach nearly the full width
      // of the cut (spans the other axis). Stepped roofs span the full width
      // while their vertical cover is naturally partial, so this keeps the
      // nice roof-profile caps. A partial width from a broken chain means the
      // plane is left open and must fall through to the rectangle fallback.
      if (sealedPolys.length > 0 && count >= 3 && oMax - oMin > 0) {
        const widthCover = (coveredOMax - coveredOMin) / (oMax - oMin)
        if (widthCover >= 0.98) {
          for (const poly of sealedPolys) {
            const tris = earClip2D(poly)
            for (const t of tris) {
              const va = vert(plane, poly[t[0]], other)
              const vb = vert(plane, poly[t[1]], other)
              const vc = vert(plane, poly[t[2]], other)
              orientPush(va, vb, vc, plane)
              capsPushed++
            }
          }
          continue
        }
      }
    }

    // ------------------------------------------------------------------
    // Fallback: guarantee a solid rectangular cap plane sealing the cut
    // whenever the rectangle plane actually cut through this building.
    // Uses the on-plane vertex bounds (other-axis and z). If the on-plane
    // vertex set is degenerate (count < 3), falls back to the full clipped
    // footprint extent along the other axis and the full building height.
    // ------------------------------------------------------------------
    if (count < 3) {
      if (segs.length === 0) continue
      let fMin = Infinity
      let fMax = -Infinity
      for (let i = 0; i < positions.length / 3; i++) {
        const o = positions[i * 3 + other]
        if (o < fMin) fMin = o
        if (o > fMax) fMax = o
      }
      oMin = fMin
      oMax = fMax
      zMin = globalZMin
      zMax = globalZMax
    }
    if (oMax - oMin < tol || zMax - zMin < tol) continue

    const p00 = vert(plane, [oMin, zMin], other)
    const p10 = vert(plane, [oMax, zMin], other)
    const p11 = vert(plane, [oMax, zMax], other)
    const p01 = vert(plane, [oMin, zMax], other)
    orientPush(p00, p10, p11, plane)
    orientPush(p00, p11, p01, plane)
  }
}

function clipMeshToRectangle(mesh: Mesh, extent: any): Mesh | null {
  const positions = mesh.vertexAttributes.position
  const vertexCount = positions.length / 3
  const components = mesh.components && mesh.components.length > 0
    ? mesh.components
    : [{ faces: null }]

  const triangles: Vec3[][] = []
  const vertAt = (idx: number): Vec3 => [
    positions[idx * 3],
    positions[idx * 3 + 1],
    positions[idx * 3 + 2]
  ]
  for (const component of components) {
    const faces = component.faces
    if (faces && faces.length > 0) {
      for (let i = 0; i + 2 < faces.length; i += 3) {
        triangles.push([vertAt(faces[i]), vertAt(faces[i + 1]), vertAt(faces[i + 2])])
      }
    } else {
      for (let i = 0; i + 2 < vertexCount; i += 3) {
        triangles.push([vertAt(i), vertAt(i + 1), vertAt(i + 2)])
      }
    }
  }

  const newPositions: number[] = []
  const newFaces: number[] = []
  const vertIndex = new Map<string, number>()
  const quantize = (v: number): string => v.toFixed(6)
  const tol = Math.max(1e-6, (extent.width + extent.height) * 1e-9)
  const planeSegments: Vec3[][][] = [[], [], [], []]
  for (const triangle of triangles) {
    const clipped = clipTriangleToExtentPlaneSegments(triangle, extent, tol)
    for (let pi = 0; pi < 4; pi++) {
      for (const seg of clipped.segments[pi]) {
        planeSegments[pi].push(seg)
      }
    }
    for (const t of clipped.triangles) {
      const triIdx: number[] = []
      for (const vert of t) {
        const key = `${quantize(vert[0])}_${quantize(vert[1])}_${quantize(vert[2])}`
        let base = vertIndex.get(key)
        if (base === undefined) {
          base = newPositions.length / 3
          vertIndex.set(key, base)
          newPositions.push(vert[0], vert[1], vert[2])
        }
        triIdx.push(base)
      }
      newFaces.push(triIdx[0], triIdx[1], triIdx[2])
    }
  }

  if (newPositions.length === 0) {
    return null
  }

  addCapFaces(newPositions, newFaces, extent, planeSegments)

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < newPositions.length; i += 3) {
    const x = newPositions[i]
    const y = newPositions[i + 1]
    const z = newPositions[i + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }

  return new Mesh({
    vertexAttributes: { position: new Float64Array(newPositions) },
    components: [{ faces: newFaces }],
    spatialReference: mesh.spatialReference,
    extent: {
      xmin: minX,
      ymin: minY,
      zmin: minZ,
      xmax: maxX,
      ymax: maxY,
      zmax: maxZ
    }
  })
}

// ---------------------------------------------------------------------------
// Polygon (administrative division) boundary walls.
// ---------------------------------------------------------------------------

/**
 * Builds a solid slab from a list of 2D rings that share the same z-range.
 * Uses the same ear clipping routine as the cap builder. Rings are assumed to
 * be in the view spatial reference (meters).
 */
function buildRingSlab(
  rings: Array<Array<[number, number]>>,
  z0: number,
  z1: number,
  sr: any
): Mesh | null {
  const positions: number[] = []
  const faces: number[] = []
  const push = (v: number[]): number => {
    const i = positions.length / 3
    positions.push(v[0], v[1], v[2])
    return i
  }
  const tri = (a: number, b: number, c: number) => faces.push(a, b, c)
  const triFlipped = (a: number, b: number, c: number) => faces.push(a, c, b)

  for (const ring of rings) {
    if (ring.length < 3) continue
    const area = signedArea2D(ring)
    if (Math.abs(area) < 1e-9) continue
    const ordered = area < 0 ? ring : ring.slice().reverse()
    const tris = earClip2D(ordered)
    if (tris.length === 0) continue
    const top = ordered.map(([x, y]) => push([x, y, z1]))
    const bottom = ordered.map(([x, y]) => push([x, y, z0]))
    for (const t of tris) {
      tri(top[t[0]], top[t[2]], top[t[1]])
      triFlipped(bottom[t[0]], bottom[t[1]], bottom[t[2]])
    }
    for (let i = 0; i < ordered.length; i++) {
      const j = (i + 1) % ordered.length
      tri(top[i], top[j], bottom[j])
      tri(top[i], bottom[j], bottom[i])
    }
  }

  if (positions.length === 0) return null
  return new Mesh({
    vertexAttributes: { position: new Float64Array(positions) },
    components: [{ faces }],
    spatialReference: sr
  })
}

/**
 * Builds a low dome (sphere cap) standing on a flat base. Used as the hazard
 * texture dot.
 */
function buildDomeMesh(cx: number, cy: number, baseZ: number, radius: number, height: number, sr: any): Mesh | null {
  const positions: number[] = []
  const faces: number[] = []
  const segs = 16
  const rings = 6
  const push = (x: number, y: number, z: number): number => {
    const i = positions.length / 3
    positions.push(x, y, z)
    return i
  }

  // Build a spherical cap (rounded dome) by stacking latitude rings from the
  // base up to the apex. Each ring's radius shrinks and height rises following
  // a cosine profile so the top is fully rounded, not pointed.
  const ringIndices: number[][] = []
  for (let r = 0; r <= rings; r++) {
    const t = r / rings
    const ang = (Math.PI / 2) * t
    const ringRadius = radius * Math.cos(ang)
    const ringZ = baseZ + height * Math.sin(ang)
    const idxs: number[] = []
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2
      idxs.push(push(cx + Math.cos(a) * ringRadius, cy + Math.sin(a) * ringRadius, ringZ))
    }
    ringIndices.push(idxs)
  }

  for (let r = 0; r < rings; r++) {
    const upper = ringIndices[r + 1]
    const lower = ringIndices[r]
    for (let s = 0; s < segs; s++) {
      const s2 = (s + 1) % segs
      faces.push(lower[s], upper[s], upper[s2])
      faces.push(lower[s], upper[s2], lower[s2])
    }
  }

  return new Mesh({
    vertexAttributes: { position: new Float64Array(positions) },
    components: [{ faces }],
    spatialReference: sr
  })
}

/**
 * Standard six-dot Braille mapping. Keys are single characters; values are the
 * raised dot numbers (1-6) in a 2x3 cell:
 *
 *   1 4
 *   2 5
 *   3 6
 *
 * Digits use the number sign (3456) prefix. Unsupported characters fall back
 * to an empty cell (space).
 */
const BRAILLE_DOTS: Record<string, number[]> = {
  'a': [1], 'b': [1, 2], 'c': [1, 4], 'd': [1, 4, 5], 'e': [1, 5],
  'f': [1, 2, 4], 'g': [1, 2, 4, 5], 'h': [1, 2, 5], 'i': [2, 4], 'j': [2, 4, 5],
  'k': [1, 3], 'l': [1, 2, 3], 'm': [1, 3, 4], 'n': [1, 3, 4, 5], 'o': [1, 3, 5],
  'p': [1, 2, 3, 4], 'q': [1, 2, 3, 4, 5], 'r': [1, 2, 3, 5], 's': [2, 3, 4], 't': [2, 3, 4, 5],
  'u': [1, 3, 6], 'v': [1, 2, 3, 6], 'w': [2, 4, 5, 6], 'x': [1, 3, 4, 6], 'y': [1, 3, 4, 5, 6], 'z': [1, 3, 5, 6],
  '1': [1], '2': [1, 2], '3': [1, 4], '4': [1, 4, 5], '5': [1, 5],
  '6': [1, 2, 4], '7': [1, 2, 4, 5], '8': [1, 2, 5], '9': [2, 4], '0': [2, 4, 5],
  ' ': [], '.': [2, 5, 6], ',': [2], "'": [3], '-': [3, 6], ';': [2, 3], ':': [2, 5], '!': [2, 3, 5], '?': [2, 3, 6], '(': [2, 3, 5, 6], ')': [2, 3, 5, 6]
}

const BRAILLE_NUMBER_SIGN = [3, 4, 5, 6]

/** Maps one character to the list of raised Braille dot numbers (1-6). */
function brailleDotsForChar(ch: string): number[] {
  const lower = ch.toLowerCase()
  if (lower in BRAILLE_DOTS) return BRAILLE_DOTS[lower]
  return []
}

/** Maps a text string to a list of Braille cells (each cell = list of dots). */
function brailleCellsForText(text: string): number[][] {
  const cells: number[][] = []
  for (const ch of text) {
    if (/[0-9]/.test(ch)) {
      cells.push(BRAILLE_NUMBER_SIGN)
      cells.push(brailleDotsForChar(ch))
    } else {
      cells.push(brailleDotsForChar(ch))
    }
  }
  return cells
}

/**
 * Builds a raised Braille label at a given ground position: each character is
 * a 2x3 cell of small dome-shaped dots sitting on the terrain. The whole label
 * is centered horizontally on (cx, cy) and reads left to right (east to west).
 * Returns a merged mesh (or null when the text produces no dots).
 */
function buildBrailleLabelMesh(
  cx: number,
  cy: number,
  text: string,
  terrain: Mesh | null,
  fallbackZ: number,
  height: number,
  dotRadius: number,
  dotPitch: number,
  cellSpacing: number,
  sr: any
): Mesh | null {
  const cells = brailleCellsForText(text)
  if (cells.length === 0) return null

  const effectiveSampler = terrain ? new TerrainSampler(terrain) : null
  const zOf = (x: number, y: number): number => {
    if (effectiveSampler) {
      const z = effectiveSampler.heightAt(x, y)
      if (z !== null && Number.isFinite(z)) return z
    }
    return fallbackZ
  }

  // Cell dot positions (offset within one cell), dot pitch p:
  //   dot1 (0,0) dot4 (p,0)
  //   dot2 (0,p) dot5 (p,p)
  //   dot3 (0,2p) dot6 (p,2p)
  // Row 0 is the NORTH/top row (dot 1), rows increase going south.
  const cellWidth = dotPitch
  const cellHeight = dotPitch * 2
  const advance = dotPitch + cellSpacing

  const totalWidth = cells.length * advance - cellSpacing
  const startX = cx - totalWidth / 2
  const startY = cy + cellHeight / 2

  const meshes: Mesh[] = []
  cells.forEach((dots, ci) => {
    const cellX = startX + ci * advance
    for (const dot of dots) {
      const col = dot <= 3 ? 0 : 1
      const row = (dot - 1) % 3
      const dx = cellX + col * dotPitch
      const dy = startY - row * dotPitch
      const dome = buildDomeMesh(dx, dy, zOf(dx, dy), dotRadius, height, sr)
      if (dome) meshes.push(dome)
    }
  })

  if (meshes.length === 0) return null
  return meshes.length === 1 ? meshes[0] : merge(meshes)
}

/**
 * Scans a feature's attributes for the most likely admin name field. Common
 * Indonesian/English keys are matched first, then any string field. Returns ''
 * when no usable field is found.
 */
function detectNameField(attributes: any): string {
  if (!attributes) return ''
  const keys = Object.keys(attributes)
  const nameKeys = keys.filter((k) =>
    /name|nama|desa|kelurahan|kecamatan|kabupaten|kota|provinsi|village|district|regency|city|province/i.test(k)
  )
  const candidateKeys = nameKeys.length > 0 ? nameKeys : keys
  for (const k of candidateKeys) {
    const v = attributes[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Approximate width/height of a Braille label for a given text, based on the
 * dot pitch and cell spacing. Used to keep labels inside the export rectangle
 * and clear of walls.
 */
function brailleLabelExtents(text: string, dotPitch: number, cellSpacing: number): { width: number, height: number } {
  const cells = brailleCellsForText(text)
  const advance = dotPitch + cellSpacing
  const width = cells.length > 0 ? cells.length * advance - cellSpacing : 0
  const height = dotPitch * 2
  return { width, height }
}

/** Ray-casting point-in-polygon test for a single ring (array of [x,y]). */
function pointInRing(px: number, py: number, ring: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** True when a point lies inside the outer ring and outside every hole. */
function pointInPolygonRings(px: number, py: number, rings: Array<Array<[number, number]>>): boolean {
  if (!rings || rings.length === 0) return false
  if (!pointInRing(px, py, rings[0])) return false
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(px, py, rings[k])) return false
  }
  return true
}

/** Distance from a point to the nearest point on a wall path (a polyline). */
function minDistToPath(px: number, py: number, path: Array<[number, number]>): number {
  let best = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const ax = path[i][0], ay = path[i][1]
    const bx = path[i + 1][0], by = path[i + 1][1]
    const abx = bx - ax, aby = by - ay
    const len2 = abx * abx + aby * aby
    let t = 0
    if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2))
    const cx = ax + t * abx, cy = ay + t * aby
    const dx = px - cx, dy = py - cy
    const d2 = dx * dx + dy * dy
    if (d2 < best) best = d2
  }
  return Math.sqrt(best)
}

/**
 * Finds the best spot for a Braille label inside the given (clipped) polygon:
 * the point that (a) lies inside the polygon, (b) keeps the whole label inside
 * the export rectangle, and (c) maximises the clearance to every admin wall
 * path. Falls back to the ring centroid when no better candidate exists.
 */
function findLabelPlacement(
  rings: Array<Array<[number, number]>>,
  extent: any,
  wallPaths: Array<{ path: Array<[number, number]>, halfWidth: number }>,
  halfW: number,
  halfH: number,
  gap: number,
  edgeGap: number
): { x: number, y: number } | null {
  if (!rings || rings.length === 0) return null
  const outer = rings[0]

  // Bounding box of the polygon clamped to the rectangle (label must fit),
  // with an extra inset from the AOI edge so labels keep a clearance margin.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of outer) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
  }
  const gx0 = Math.max(minX, extent.xmin + halfW + edgeGap)
  const gx1 = Math.min(maxX, extent.xmax - halfW - edgeGap)
  const gy0 = Math.max(minY, extent.ymin + halfH + edgeGap)
  const gy1 = Math.min(maxY, extent.ymax - halfH - edgeGap)
  if (gx1 <= gx0 || gy1 <= gy0) {
    // The label cannot fit fully inside the AOI with the required clearance.
    // Retry with no edge gap so wide names (e.g. long regency names) can still
    // be placed entirely inside the AOI instead of being dropped.
    const rx0 = Math.max(minX, extent.xmin + halfW)
    const rx1 = Math.min(maxX, extent.xmax - halfW)
    const ry0 = Math.max(minY, extent.ymin + halfH)
    const ry1 = Math.min(maxY, extent.ymax - halfH)
    if (rx1 > rx0 && ry1 > ry0) {
      return findLabelPlacement(rings, extent, wallPaths, halfW, halfH, gap, 0)
    }
    console.log('[stl-export] label placement: no room within AOI even without edge gap', { rx0, rx1, ry0, ry1, halfW, halfH })
    return null
  }

  const required = Math.sqrt(halfW * halfW + halfH * halfH) + gap

  const score = (x: number, y: number): number => {
    let best = Infinity
    for (const wp of wallPaths) {
      const d = minDistToPath(x, y, wp.path)
      const clear = d - wp.halfWidth
      if (clear < best) best = clear
    }
    return best
  }

  // Two-pass grid search: coarse then refine around the best cell.
  let best = { x: (gx0 + gx1) / 2, y: (gy0 + gy1) / 2, score: -Infinity }
  let pass = 0
  let x0 = gx0, y0 = gy0, w = gx1 - gx0, h = gy1 - gy0
  while (pass < 2) {
    const n = 16
    for (let r = 0; r <= n; r++) {
      for (let c = 0; c <= n; c++) {
        const x = x0 + (c / n) * w
        const y = y0 + (r / n) * h
        if (!pointInPolygonRings(x, y, rings)) continue
        const s = score(x, y)
        if (s > best.score) best = { x, y, score: s }
      }
    }
    pass++
    if (pass === 1) {
      const cellW = w / n
      const cellH = h / n
      x0 = Math.max(gx0, best.x - cellW)
      y0 = Math.max(gy0, best.y - cellH)
      w = Math.min(gx1, best.x + cellW) - x0
      h = Math.min(gy1, best.y + cellH) - y0
    }
  }

  if (best.score !== -Infinity) {
    return { x: best.x, y: best.y }
  }
  // No grid point inside the polygon stayed within the AOI/clearance bounds;
  // drop the label rather than let it hang over the AOI edge.
  return null
}

/**
 * Builds a thin raised wall that follows one polygon ring, by buffering the
 * ring as a polyline and extruding the buffered footprint as a slab.
 */
function buildRingWallMesh(ring: any, halfWidth: number, z0: number, z1: number, sr: any): Mesh | null {
  const flat = ring.map((p: any) => ([p[0], p[1]] as [number, number]))
  if (flat.length < 3) return null
  const polyline = new Polyline({
    paths: [flat],
    spatialReference: sr
  })
  let buf: any
  try {
    buf = geometryEngine.buffer(polyline, halfWidth)
  } catch (e) {
    console.warn('[stl-export] buffer ring failed', e)
    return null
  }
  if (!buf || !buf.rings) return null
  const rings: Array<Array<[number, number]>> = buf.rings.map(
    (ringp: any) => ringp.map((p: any) => [p[0], p[1]] as [number, number])
  )
  return buildRingSlab(rings, z0, z1, sr)
}

/**
 * Builds a raised wall along a set of 2D paths (from a line feature: road,
 * river, railway, ...) by buffering the paths as a polyline and extruding the
 * buffered footprint as a slab.
 */
function buildLineWallFromPaths(paths: Array<Array<[number, number]>>, halfWidth: number, z0: number, z1: number, sr: any): Mesh | null {
  const valid = paths.filter((p) => p.length >= 2)
  if (valid.length === 0) return null
  const polyline = new Polyline({
    paths: valid,
    spatialReference: sr
  })
  let buf: any
  try {
    buf = geometryEngine.buffer(polyline, halfWidth)
  } catch (e) {
    console.warn('[stl-export] buffer line failed', e)
    return null
  }
  if (!buf || !buf.rings) return null
  const rings: Array<Array<[number, number]>> = buf.rings.map(
    (ringp: any) => ringp.map((p: any) => [p[0], p[1]] as [number, number])
  )
  return buildRingSlab(rings, z0, z1, sr)
}

/**
 * Unit upward terrain normal at a point, computed from the height field via
 * central differences. Returns [0, 0, 1] (vertical) when no sampler is present
 * or the height cannot be sampled.
 */
function terrainNormalAt(
  sampler: TerrainSampler | null,
  x: number,
  y: number,
  fallbackZ: number
): [number, number, number] {
  if (!sampler) return [0, 0, 1]
  const step = Math.max(sampler.getCellSize, 0.5)
  const zc = sampler.heightAt(x, y)
  const zx = sampler.heightAt(x + step, y)
  const zy = sampler.heightAt(x, y + step)
  if (zc === null || zx === null || zy === null ||
      !Number.isFinite(zc) || !Number.isFinite(zx) || !Number.isFinite(zy)) {
    return [0, 0, 1]
  }
  const gx = (zx - zc) / step
  const gy = (zy - zc) / step
  const gn = Math.hypot(gx, gy, 1)
  if (gn < 1e-12) return [0, 0, 1]
  return [-gx / gn, -gy / gn, 1 / gn]
}

/**
 * Builds a terrain-clamped raised wall along a set of 2D paths. The buffered
 * footprint of the paths is extruded as a slab whose base follows the terrain
 * surface at each footprint vertex (like buildings seated on the DEM) and whose
 * top is lifted by the configured wall height. When no terrain is available the
 * wall falls back to a flat slab between fallbackZ and fallbackZ + wallHeight.
 */
function buildDrapedLineWallsFromPaths(
  paths: Array<Array<[number, number]>>,
  halfWidth: number,
  terrain: Mesh | null,
  wallHeight: number,
  fallbackZ: number,
  sr: any,
  sampler?: TerrainSampler | null
): Mesh | null {
  const valid = paths.filter((p) => p.length >= 2)
  if (valid.length === 0) return null
  const polyline = new Polyline({
    paths: valid,
    spatialReference: sr
  })
  let buf: any
  try {
    buf = geometryEngine.buffer(polyline, halfWidth)
  } catch (e) {
    console.warn('[stl-export] buffer line failed', e)
    return null
  }
  if (!buf || !buf.rings) return null
  const effectiveSampler = sampler !== undefined ? sampler : (terrain ? new TerrainSampler(terrain) : null)

  const positions: number[] = []
  const faces: number[] = []
  const push = (v: number[]): number => {
    const i = positions.length / 3
    positions.push(v[0], v[1], v[2])
    return i
  }
  const tri = (a: number, b: number, c: number) => faces.push(a, b, c)
  const triFlipped = (a: number, b: number, c: number) => faces.push(a, c, b)

  const rings: Array<Array<[number, number]>> = buf.rings.map(
    (ringp: any) => ringp.map((p: any) => [p[0], p[1]] as [number, number])
  )

  for (const ring of rings) {
    if (ring.length < 3) continue
    const area = signedArea2D(ring)
    if (Math.abs(area) < 1e-9) continue
    const ordered = area < 0 ? ring : ring.slice().reverse()
    const tris = earClip2D(ordered)
    if (tris.length === 0) continue
    const zOf = (x: number, y: number): number => {
      if (effectiveSampler) {
        const z = effectiveSampler.heightAt(x, y)
        if (z !== null && Number.isFinite(z)) return z
      }
      return fallbackZ
    }
    const normOf = (x: number, y: number): [number, number, number] =>
      terrainNormalAt(effectiveSampler, x, y, fallbackZ)
    const embed = 0.1
    const top: number[] = []
    const bottom: number[] = []
    for (const [x, y] of ordered) {
      const z = zOf(x, y)
      const [nxn, nyn, nzn] = normOf(x, y)
      top.push(push([x + nxn * wallHeight, y + nyn * wallHeight, z + nzn * wallHeight]))
      bottom.push(push([x - nxn * embed, y - nyn * embed, z - nzn * embed]))
    }
    for (const t of tris) {
      tri(top[t[0]], top[t[2]], top[t[1]])
      triFlipped(bottom[t[0]], bottom[t[1]], bottom[t[2]])
    }
    for (let i = 0; i < ordered.length; i++) {
      const j = (i + 1) % ordered.length
      tri(top[i], top[j], bottom[j])
      tri(top[i], bottom[j], bottom[i])
    }
  }

  if (positions.length === 0) return null
  return new Mesh({
    vertexAttributes: { position: new Float64Array(positions) },
    components: [{ faces }],
    spatialReference: sr
  })
}

/**
 * Reduces a ring to at most `maxVerts` vertices by dropping points uniformly,
 * so very dense/complex polygon boundaries triangulate reliably.
 */
function decimateRing(ring: Array<[number, number]>, maxVerts: number): Array<[number, number]> {
  if (ring.length <= maxVerts) return ring
  const keep = Math.max(1, Math.floor(ring.length / maxVerts))
  const out: Array<[number, number]> = []
  for (let i = 0; i < ring.length; i += keep) out.push(ring[i])
  if (out.length < 3) out.push(ring[ring.length - 1])
  return out
}

/**
 * Builds a filled solid slab covering the full area of the given polygon ring
 * groups, seated into the terrain as a foundation pad.
 *
 * The top surface follows the terrain relief (sampled across the whole
 * interior via recursive subdivision) raised by `height` — the terrain itself
 * is never modified. The bottom surface is a flat plane below the lowest
 * terrain point under the polygon, so the slab is embedded into the ground
 * everywhere (no floating gaps between the terrain and the polygon base), like
 * the foundation pads under buildings.
 */
function buildDrapedPolygonArea(
  ringGroups: Array<Array<Array<[number, number]>>>,
  terrain: Mesh | null,
  height: number,
  fallbackZ: number,
  sr: any
): Mesh | null {
  const sampler = terrain ? new TerrainSampler(terrain) : null
  const positions: number[] = []
  const faces: number[] = []
  const push = (v: number[]): number => {
    const i = positions.length / 3
    positions.push(v[0], v[1], v[2])
    return i
  }
  const tri = (a: number, b: number, c: number) => faces.push(a, b, c)
  const triFlipped = (a: number, b: number, c: number) => faces.push(a, c, b)

  const zOf = (x: number, y: number): number | null => {
    if (sampler) {
      const z = sampler.heightAt(x, y)
      if (z !== null && Number.isFinite(z)) return z
    }
    return null
  }

  for (const rings of ringGroups) {
    if (rings.length === 0) continue
    const outer = decimateRing(rings[0], 800)
    if (outer.length < 3) continue
    const area = signedArea2D(outer)
    if (Math.abs(area) < 1e-9) continue
    const ordered = area < 0 ? outer : outer.slice().reverse()
    const tris = earClip2D(ordered)
    if (tris.length === 0) continue

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of ordered) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }

    // Find the lowest ground under the polygon (foundation pad depth) by
    // sampling the ring vertices plus a regular grid over the interior.
    let tMin = Infinity
    const consider = (x: number, y: number) => {
      const z = zOf(x, y)
      if (z !== null && z < tMin) tMin = z
    }
    for (const [x, y] of ordered) consider(x, y)
    const spanX = maxX - minX
    const spanY = maxY - minY
    if (spanX > 0 && spanY > 0) {
      const cells = 24
      for (let r = 0; r < cells; r++) {
        for (let c = 0; c < cells; c++) {
          const gx = minX + ((c + 0.5) / cells) * spanX
          const gy = minY + ((r + 0.5) / cells) * spanY
          if (pointInRings2D(gx, gy, rings)) consider(gx, gy)
        }
      }
    }
    const bottomZ = Number.isFinite(tMin)
      ? tMin - 0.1
      : fallbackZ

    const topZ = (x: number, y: number): number => {
      const z = zOf(x, y)
      return (z === null ? fallbackZ : z) + height
    }
    console.log('[stl-export] buildDrapedPolygonArea: height(m) =', height, 'fallbackZ =', fallbackZ, 'terrain =', !!sampler, 'minX =', minX, 'maxX =', maxX, 'minY =', minY, 'maxY =', maxY, 'tMin =', tMin)

    const span = Math.max(spanX, spanY, 1e-6)
    const cellArea = (span / 256) * (span / 256)

    const topIdx: number[] = []
    const bottomIdx: number[] = []
    for (const [x, y] of ordered) {
      topIdx.push(push([x, y, topZ(x, y)]))
      bottomIdx.push(push([x, y, bottomZ]))
    }

    const emitQuad = (a: number, b: number, c: number) => {
      tri(topIdx[a], topIdx[c], topIdx[b])
      triFlipped(bottomIdx[a], bottomIdx[b], bottomIdx[c])
    }

    const subdivide = (a: number, b: number, c: number, depth: number) => {
      const ax = positions[topIdx[a] * 3]
      const ay = positions[topIdx[a] * 3 + 1]
      const bx = positions[topIdx[b] * 3]
      const by = positions[topIdx[b] * 3 + 1]
      const cx = positions[topIdx[c] * 3]
      const cy = positions[topIdx[c] * 3 + 1]
      const triArea = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2
      if (triArea <= cellArea || depth >= 11) {
        emitQuad(a, b, c)
        return
      }
      const mx = (ax + bx + cx) / 3
      const my = (ay + by + cy) / 3
      const nt = topIdx.length
      topIdx.push(push([mx, my, topZ(mx, my)]))
      bottomIdx.push(push([mx, my, bottomZ]))
      subdivide(a, b, nt, depth + 1)
      subdivide(b, c, nt, depth + 1)
      subdivide(c, a, nt, depth + 1)
    }

    for (const t of tris) {
      subdivide(t[0], t[1], t[2], 0)
    }

    for (let i = 0; i < ordered.length; i++) {
      const j = (i + 1) % ordered.length
      tri(topIdx[i], topIdx[j], bottomIdx[j])
      tri(topIdx[i], bottomIdx[j], bottomIdx[i])
    }
  }

  if (positions.length === 0) return null
  return new Mesh({
    vertexAttributes: { position: new Float64Array(positions) },
    components: [{ faces }],
    spatialReference: sr
  })
}

/**
 * Queries line feature layers (roads, rivers, ...) that intersect the drawn
 * rectangle and raises their lines as thin walls. Returns one merged mesh (or
 * null if no line layers produced geometry).
 */
async function buildLineFeatureWalls(view: SceneView, rectangle: Polygon, terrain: Mesh | null, config: Config): Promise<Mesh | null> {
  const viewSR = view.spatialReference
  const meshes: Mesh[] = []
  const fallbackZ = terrain ? minZOf(terrain) : (config.baseZ0 ?? 0)

  const query = new Query({
    geometry: rectangle,
    spatialRelationship: 'intersects',
    returnGeometry: true,
    outFields: ['*']
  })

  for (const layer of view.map.allLayers) {
    const lyr = layer as any
    if (typeof lyr.queryFeatures !== 'function') continue
    const gType = (lyr.geometryType || '').toLowerCase()
    if (gType !== 'polyline' && gType !== 'polygon') {
      console.log('[stl-export] line walls: skip layer', lyr.title, 'type =', lyr.geometryType)
      continue
    }
    const isPolyline = gType === 'polyline'
    const roadsCat = isPolyline ? config.roadsLayerId : config.roadsPolygonLayerId
    const riversCat = isPolyline ? config.riversLayerId : config.riversPolygonLayerId
    const roadsInclude = config.includeRoads !== false && lineCategoryIncludes(roadsCat, lyr, config)
    const riversInclude = config.includeRivers !== false && lineCategoryIncludes(riversCat, lyr, config)
    if (!roadsInclude && !riversInclude) {
      console.log('[stl-export] line walls: layer excluded by dropdowns, skipping', lyr.title)
      continue
    }

    let layerView: any
    try {
      layerView = await view.whenLayerView(lyr)
    } catch (e) {
      console.warn('[stl-export] line walls: no layer view for', lyr.title, e)
      continue
    }

    try {
      const result = await layerView.queryFeatures(query)
      console.log('[stl-export] line walls: queried', lyr.title, '=>', result.features.length, 'features')
      const paths: Array<Array<[number, number]>> = []
      const ringGeoms: Array<Array<Array<[number, number]>>> = []
      for (const feature of result.features) {
        const geom = (feature as any).geometry
        if (!geom) continue
        const projected = geom.spatialReference && !geom.spatialReference.equals(viewSR)
          ? (projectOperator.execute(geom, viewSR) as any)
          : geom
        if (!projected) continue

        let clippedGeom = projected
        try {
          clippedGeom = geometryEngine.clip(projected, rectangle.extent) as any
        } catch (e) {
          console.warn('[stl-export] line walls: clip failed', lyr.title, e)
        }
        if (!clippedGeom) continue

        if (clippedGeom.paths) {
          for (const path of clippedGeom.paths) {
            const flat: Array<[number, number]> = path.map((p: any) => [p[0], p[1]] as [number, number])
            if (flat.length >= 2) paths.push(flat)
          }
        }
        if (clippedGeom.rings) {
          const rings: Array<Array<[number, number]>> = clippedGeom.rings.map(
            (ringp: any) => ringp.map((p: any) => [p[0], p[1]] as [number, number])
          )
          if (isPolyline) {
            for (const ring of rings) {
              if (ring.length >= 2) paths.push(ring)
            }
          } else {
            ringGeoms.push(rings)
          }
        }
      }

      if (!isPolyline) {
        if (ringGeoms.length === 0) {
          console.log('[stl-export] line walls: no rings after clipping for', lyr.title)
          continue
        }
        const isRiverPolygon = riversInclude && !isPolyline
        const polygonHeight = mmToMeters(roadsInclude
          ? (config.roadsPolygonHeight ?? 0.6)
          : (config.riversPolygonHeight ?? 0.6), rectangle.extent, config)
        const area = buildDrapedPolygonArea(ringGeoms, terrain, polygonHeight, fallbackZ, viewSR)
        if (area) meshes.push(area)
        continue
      }

      if (paths.length === 0) {
        console.log('[stl-export] line walls: no paths after clipping for', lyr.title)
        continue
      }

      let wall: Mesh | null
      const wallHalfWidth = mmToMeters(roadsInclude
        ? (config.roadsWallHalfWidth ?? 0.1)
        : (config.riversWallHalfWidth ?? 0.1), rectangle.extent, config)
      const wallHeight = mmToMeters(roadsInclude
        ? (config.roadsWallHeight ?? 0.6)
        : (config.riversWallHeight ?? 0.6), rectangle.extent, config)
      if (terrain) {
        wall = buildDrapedLineWallsFromPaths(paths, wallHalfWidth, terrain, wallHeight, fallbackZ, viewSR)
      } else {
        const baseZ = linePathsBaseZ(paths, terrain, fallbackZ)
        wall = buildLineWallFromPaths(paths, wallHalfWidth, baseZ, baseZ + wallHeight, viewSR)
      }
      if (wall) meshes.push(wall)
    } catch (e) {
      console.warn('[stl-export] line walls: query failed', lyr.title, e)
    }
  }

  if (meshes.length === 0) return null
  return merge(meshes)
}

/**
 * Samples the ground surface height at the centroid of the given line paths.
 */
function linePathsBaseZ(paths: Array<Array<[number, number]>>, terrain: Mesh | null, fallbackZ: number): number {
  if (terrain) {
    let cx = 0
    let cy = 0
    let n = 0
    for (const path of paths) {
      for (const p of path) {
        cx += p[0]
        cy += p[1]
        n++
      }
    }
    if (n > 0) {
      cx /= n
      cy /= n
      const z = terrainHeightAt(terrain, cx, cy)
      if (z !== null && Number.isFinite(z)) return z
    }
  }
  return fallbackZ
}

/**
 * Samples the ground surface height at a ring centroid. If a terrain mesh is
 * available the surface height is read from it; otherwise falls back to the
 * configured baseZ0.
 */
function ringBaseZ(ring: any, terrain: Mesh | null, fallbackZ: number): number {
  if (terrain) {
    let cx = 0
    let cy = 0
    const n = ring.length
    for (const p of ring) {
      cx += p[0]
      cy += p[1]
    }
    cx /= n
    cy /= n
    const z = terrainHeightAt(terrain, cx, cy)
    if (z !== null && Number.isFinite(z)) return z
  }
  return fallbackZ
}

/**
 * Returns true when the layer should be included in the export.
 * An empty selection means "export all eligible layers".
 * A layer is also included when one of its parent layers is selected (e.g. a
 * BuildingSceneLayer parent covers its sublayers).
 */
function layerSelected(lyr: any, config: Config): boolean {
  const selected = config.selectedLayerIds
  if (!selected || selected.length === 0) return true
  if (selected.indexOf(LAYER_SELECT_NONE) !== -1) return false
  if (selected.indexOf(lyr.id) !== -1) return true
  if (lyr.parent) {
    let parent = lyr.parent
    while (parent && parent.id !== null && parent.id !== undefined) {
      if (selected.indexOf(parent.id) !== -1) return true
      parent = parent.parent
    }
  }
  return false
}

/**
 * Decides whether a polyline/polygon layer is included for one line category
 * (roads or rivers):
 * - '__none__' (or empty/legacy '') -> "None": exclude this category entirely.
 * - otherwise    -> only include the layer whose id matches the selection.
 */
function lineCategoryIncludes(categoryId: string | undefined, lyr: any, config: Config): boolean {
  if (categoryId === '__none__' || !categoryId) return false
  return lyr.id === categoryId
}

/**
 * Builds a flat rectangular base plate spanning the full rectangle. The top
 * surface sits at baseZ0 so walls / bands drawn on the flat base align with it.
 */
function buildFlatBase(rectangle: Polygon, config: Config): Mesh | null {
  const extent = rectangle.extent
  const zBottom = (config.baseZ0 ?? 0) - mmToMeters(config.flatBaseThickness ?? 0.4, extent, config)
  const ring: Array<[number, number]> = [
    [extent.xmin, extent.ymin],
    [extent.xmax, extent.ymin],
    [extent.xmax, extent.ymax],
    [extent.xmin, extent.ymax]
  ]
  return buildRingSlab([ring], zBottom, config.baseZ0 ?? 0, rectangle.spatialReference)
}

/**
 * Returns the flat reference height (top of the offset margin frame): the
 * lowest AOI terrain point when terrain exists, otherwise baseZ0. The frame's
 * bottom is lowered separately to match the extrude base when enabled.
 */
function marginFrameZ(terrain: Mesh | null, config: Config): number {
  if (terrain) return minZOf(terrain)
  return config.baseZ0 ?? 0
}

/** Margin box (m) around the AOI used by the margin furniture builders. */
interface MarginBox {
  top: number
  left: number
  right: number
  bottom: number
}

/**
 * Effective print scale denominator for the AOI. When layoutFitToPlate is on the
 * scale is set so the AOI exactly fills the plate map frame (the constraining
 * dimension). Otherwise it uses layoutScaleDenom. Used to convert plate mm to
 * ground meters (1 mm on the plate = scaleDenom / 1000 m on the ground).
 */
function effectiveScaleDenom(extent: { width: number, height: number }, config: Config): number {
  if (config.layoutFitToPlate) {
    const plate = plateSizeMm(config)
    const topMm = config.layoutMarginTop ?? 25
    const leftMm = config.layoutMarginLeft ?? 10
    const rightMm = config.layoutMarginRight ?? 10
    const bottomMm = config.layoutMarginBottom ?? 10
    const frameW = Math.max(plate.width - leftMm - rightMm, 1)
    const frameH = Math.max(plate.height - topMm - bottomMm, 1)
    return Math.max(extent.width * 1000 / frameW, extent.height * 1000 / frameH)
  }
  return config.layoutScaleDenom ?? 5000
}

/** Converts a plate dimension given in mm to ground meters at the print scale. */
function mmToMeters(mm: number, extent: { width: number, height: number }, config: Config): number {
  return mm * effectiveScaleDenom(extent, config) / 1000
}

/**
 * Derives the Braille dot geometry from the single font-size setting (mm on
 * plate): dot pitch = font size, dot radius = 32% of the font size and extra
 * cell spacing = 80% of the font size (standard Braille proportions).
 */
function brailleMetrics(fontSizeMm: number): { radius: number, pitch: number, cellSpacing: number } {
  const fs = Math.max(fontSizeMm, 0.1)
  return { radius: fs * 0.32, pitch: fs, cellSpacing: fs * 0.8 }
}

/** Converts an admin wall config (mm on plate) to ground meters at the print scale. */
function adminWallCfgMeters(cfg: AdminLevelWallConfig, extent: { width: number, height: number }, config: Config): AdminLevelWallConfig {
  return {
    ...cfg,
    height: mmToMeters(cfg.height ?? 0.6, extent, config),
    halfWidth: mmToMeters(cfg.halfWidth ?? 0.3, extent, config),
    dashLength: mmToMeters(cfg.dashLength ?? 1.8, extent, config),
    dotLength: mmToMeters(cfg.dotLength ?? 0.6, extent, config),
    gap: mmToMeters(cfg.gap ?? 0.4, extent, config)
  }
}

/**
 * Returns the margin box around the AOI in meters. The margins come from the
 * layout settings (plate size, print scale, margins in mm): mm on the plate are
 * converted to ground meters via the print scale (1 mm on the plate =
 * scaleDenom / 1000 m on the ground). When `layoutFitToPlate` is set the scale
 * is auto-adjusted so the AOI fits the plate map frame.
 */
function layoutMarginsMeters(
  extent: { width: number, height: number },
  config: Config
): MarginBox {
  const topMm = config.layoutMarginTop ?? 25
  const leftMm = config.layoutMarginLeft ?? 10
  const rightMm = config.layoutMarginRight ?? 10
  const bottomMm = config.layoutMarginBottom ?? 10
  const mPerMm = effectiveScaleDenom(extent, config) / 1000
  return {
    top: topMm * mPerMm,
    left: leftMm * mPerMm,
    right: rightMm * mPerMm,
    bottom: bottomMm * mPerMm
  }
}

/**
 * Returns the bottom height of the offset margin frame. When the terrain is
 * extruded the frame is dropped to the same level as the extrude base bottom
 * (minZ - extrusionDepth) so the flat offset is flush with the base plate;
 * otherwise it sits `marginThickness` below the frame top.
 */
function marginFrameBottom(frameZ: number, terrain: Mesh | null, extent: { width: number, height: number }, config: Config): number {
  if (terrain && config.extrudeBase) {
    return frameZ - mmToMeters(config.extrusionDepth ?? 2, extent, config)
  }
  return frameZ - mmToMeters(config.marginThickness ?? 2, extent, config)
}

/**
 * Builds the flat offset frame around the AOI. Four rectangular slabs (top,
 * left, right, bottom margins) with their top at the lowest AOI terrain height
 * and their bottom matched to the extrude base when enabled. Returns an array
 * of meshes.
 */
function buildMarginFrame(rectangle: Polygon, frameZ: number, terrain: Mesh | null, config: Config, margins: MarginBox): Mesh[] {
  const extent = rectangle.extent
  const zBottom = marginFrameBottom(frameZ, terrain, extent, config)
  const top = margins.top
  const left = margins.left
  const right = margins.right
  const bottom = margins.bottom
  const sr = rectangle.spatialReference

  const slabs: Array<Array<[number, number]>> = [
    // Top (north) strip.
    [
      [extent.xmin - left, extent.ymax],
      [extent.xmax + right, extent.ymax],
      [extent.xmax + right, extent.ymax + top],
      [extent.xmin - left, extent.ymax + top]
    ],
    // Left (west) strip.
    [
      [extent.xmin - left, extent.ymin],
      [extent.xmin, extent.ymin],
      [extent.xmin, extent.ymax],
      [extent.xmin - left, extent.ymax]
    ],
    // Right (east) strip.
    [
      [extent.xmax, extent.ymin],
      [extent.xmax + right, extent.ymin],
      [extent.xmax + right, extent.ymax],
      [extent.xmax, extent.ymax]
    ],
    // Bottom (south) strip.
    [
      [extent.xmin - left, extent.ymin - bottom],
      [extent.xmax + right, extent.ymin - bottom],
      [extent.xmax + right, extent.ymin],
      [extent.xmin - left, extent.ymin]
    ]
  ]

  const meshes: Mesh[] = []
  for (const slab of slabs) {
    const m = buildRingSlab([slab], zBottom, frameZ, sr)
    if (m) meshes.push(m)
  }
  return meshes
}

/**
 * Builds a raised Braille map title centred on the top margin.
 */
function buildMarginTitle(rectangle: Polygon, frameZ: number, config: Config, margins: MarginBox): Mesh | null {
  const extent = rectangle.extent
  const top = margins.top
  const cx = (extent.xmin + extent.xmax) / 2
  const cy = extent.ymax + top / 2
  const m = brailleMetrics(config.furnitureLabelFontSize ?? config.labelFontSize ?? 2.5)
  return buildBrailleLabelMesh(
    cx,
    cy,
    config.mapTitle,
    null,
    frameZ,
    mmToMeters(config.furnitureLabelDomeHeight ?? config.labelDomeHeight ?? 0.5, extent, config),
    mmToMeters(m.radius, extent, config),
    mmToMeters(m.pitch, extent, config),
    mmToMeters(m.cellSpacing, extent, config),
    rectangle.spatialReference
  )
}

/**
 * Builds an alternating raised/lowered block scale bar centred on the bottom
 * margin. Even segments are fully raised, odd segments sit at half height so
 * fingers can distinguish the ticks.
 */
function buildMarginScaleBar(rectangle: Polygon, frameZ: number, config: Config, margins: MarginBox): Mesh | null {
  const extent = rectangle.extent
  const bottom = margins.bottom
  const sr = rectangle.spatialReference

  // Pick a "nice" round distance (in km) for the single scale bar block based
  // on the configured length in mm on the plate.
  const desiredLenM = mmToMeters(config.scaleBarLength ?? 40, extent, config)
  const niceKm = niceDistanceKm(desiredLenM)
  const length = niceKm * 1000
  const fullWidth = mmToMeters(config.scaleBarWidth ?? 3, extent, config)
  const fullHeight = mmToMeters(config.scaleBarHeight ?? 0.8, extent, config)

  const cy = extent.ymin - bottom / 2
  const halfW = fullWidth / 2
  // The scale bar's left edge sits at the offset distance from the plate's left
  // edge, i.e. aligned with the AOI/frame left edge (extent.xmin).
  const x0 = extent.xmin
  const x1 = x0 + length

  const meshes: Mesh[] = []
  const ring: Array<[number, number]> = [
    [x0, cy - halfW],
    [x1, cy - halfW],
    [x1, cy + halfW],
    [x0, cy + halfW]
  ]
  const block = buildRingSlab([ring], frameZ - 0.1, frameZ + fullHeight, sr)
  if (block) meshes.push(block)

  // Single number (units in km) placed right after the scale bar block so the
  // distance is read next to the bar itself.
  const labelText = formatKmLabel(niceKm)
  const m = brailleMetrics(config.furnitureLabelFontSize ?? config.labelFontSize ?? 2.5)
  const labelPitch = mmToMeters(m.pitch, extent, config)
  const labelSpacing = mmToMeters(m.cellSpacing, extent, config)
  const labelW = brailleLabelExtents(labelText, labelPitch, labelSpacing).width
  if (config.includeLabels && config.includeFurnitureLabels !== false) {
    const label = buildBrailleLabelMesh(
      x1 + mmToMeters(config.furnitureLabelEdgeGap ?? config.labelEdgeGap ?? 4, extent, config) + labelW / 2,
      cy - halfW - 2.5,
      labelText,
      null,
      frameZ,
      mmToMeters(config.furnitureLabelDomeHeight ?? config.labelDomeHeight ?? 0.5, extent, config),
      mmToMeters(m.radius, extent, config),
      labelPitch,
      labelSpacing,
      sr
    )
    if (label) meshes.push(label)
  }

  if (meshes.length === 0) return null
  return meshes.length === 1 ? meshes[0] : merge(meshes)
}

/**
 * Builds a raised Braille print-scale label (e.g. "1:5000") placed on the
 * bottom-right of the margin, opposite the scale bar.
 */
function buildMarginPrintScale(rectangle: Polygon, frameZ: number, config: Config, margins: MarginBox): Mesh | null {
  const extent = rectangle.extent
  const bottom = margins.bottom
  const sr = rectangle.spatialReference
  const denom = Math.round(effectiveScaleDenom(extent, config))
  const text = `1:${denom.toLocaleString()}`

  const m = brailleMetrics(config.furnitureLabelFontSize ?? config.labelFontSize ?? 2.5)
  const pitch = mmToMeters(m.pitch, extent, config)
  const spacing = mmToMeters(m.cellSpacing, extent, config)
  const w = brailleLabelExtents(text, pitch, spacing).width
  const cy = extent.ymin - bottom / 2
  // Right-align to the offset distance from the plate's right edge, i.e. aligned
  // with the AOI/frame right edge (extent.xmax), mirroring the scale bar.
  const cx = extent.xmax - w / 2

  return buildBrailleLabelMesh(
    cx,
    cy,
    text,
    null,
    frameZ,
    mmToMeters(config.furnitureLabelDomeHeight ?? config.labelDomeHeight ?? 0.5, extent, config),
    mmToMeters(m.radius, extent, config),
    pitch,
    spacing,
    sr
  )
}

/**
 * Returns the largest "nice" km value (1, 2, 5 x 10^n) that is <= the given
 * ground distance in meters. Falls back to the closest smaller nice value.
 */
function niceDistanceKm(meters: number): number {
  if (!Number.isFinite(meters) || meters <= 0) return 1
  const km = meters / 1000
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(km, 0.1))))
  const normalized = km / mag
  let nice = 1
  if (normalized >= 5) nice = 5
  else if (normalized >= 2) nice = 2
  else if (normalized >= 1) nice = 1
  else nice = 0.5
  return nice * mag
}

/** Formats a km value for the scale bar label, e.g. "1km", "0.5km", "2km". */
function formatKmLabel(km: number): string {
  const s = Number.isInteger(km) ? String(km) : km.toFixed(1)
  return s + 'km'
}

/**
 * Builds a raised 3D north arrow on the top-right margin, pointing north (up
 * on the map). The arrow is an extruded arrowhead polygon: a shaft plus a
 * triangular head.
 */
function buildMarginNorthArrow(rectangle: Polygon, frameZ: number, config: Config, margins: MarginBox): Mesh | null {
  const extent = rectangle.extent
  const top = margins.top
  const length = mmToMeters(config.northArrowLength ?? 10, extent, config)
  const shaftWidth = mmToMeters(config.northArrowWidth ?? 5, extent, config)
  const height = mmToMeters(config.northArrowHeight ?? 3, extent, config)
  const sr = rectangle.spatialReference

  // Position the arrow in the top-left of the offset zone: centered over the
  // left margin strip horizontally and the top margin strip vertically, so it
  // stays entirely OUTSIDE the AOI (above ymax) and clear of the frame edges.
  const gap = mmToMeters(config.northArrowGap ?? 8, extent, config)
  const effLen = Math.max(Math.min(length, top - 2 * gap), 0.001)

  const shaft = shaftWidth / 2
  const head = shaft + shaftWidth * 0.5
  // Align the arrow's left edge with the AOI/frame left edge (extent.xmin),
  // mirroring how the scale bar's left edge aligns on the bottom margin.
  const cx = extent.xmin + head
  const cy = extent.ymax + gap + effLen / 2

  const shaftTop = cy - effLen * 0.2
  const tipY = cy + effLen * 0.5

  // Arrowhead polygon (base at cy-effLen*0.5, tip pointing north).
  const ring: Array<[number, number]> = [
    [cx - shaft, cy - effLen * 0.5],
    [cx + shaft, cy - effLen * 0.5],
    [cx + shaft, shaftTop],
    [cx + head, shaftTop],
    [cx, tipY],
    [cx - head, shaftTop],
    [cx - shaft, shaftTop]
  ]

  return buildRingSlab([ring], frameZ - 0.1, frameZ + height, sr)
}

/**
 * Returns the [x, y] point at the given cumulative arc length along a ring
 * (measured from ring[0]). `total` is the ring's full perimeter.
 */
function pointAtArcLength(ring: Array<[number, number]>, total: number, dist: number): [number, number] {
  if (ring.length === 0) return [0, 0]
  if (ring.length === 1) return ring[0]
  const d = ((dist % total) + total) % total
  let traveled = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    const seg = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (seg <= 0) continue
    if (traveled + seg >= d) {
      const t = (d - traveled) / seg
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    }
    traveled += seg
  }
  return ring[ring.length - 1]
}

/**
 * Builds one level rectangular box spanning the ring between arc lengths s0
 * and s1, with the given cross-section half-width. The box is a distinct 3D
 * block: a flat bottom seated just below the lowest terrain point under it
 * (foundation pad, no floating gaps) and a flat top `height` above that
 * bottom. Corners are oriented with the long axis along the ring segment.
 */
function buildDashDotBlock(
  ring: Array<[number, number]>,
  total: number,
  s0: number,
  s1: number,
  halfWidth: number,
  height: number,
  zOf: (x: number, y: number) => number,
  sr: any
): Mesh | null {
  const p0 = pointAtArcLength(ring, total, s0)
  const p1 = pointAtArcLength(ring, total, s1)
  const dx = p1[0] - p0[0]
  const dy = p1[1] - p0[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux

  const corners: Array<[number, number]> = [
    [p0[0] + nx * halfWidth, p0[1] + ny * halfWidth],
    [p0[0] - nx * halfWidth, p0[1] - ny * halfWidth],
    [p1[0] - nx * halfWidth, p1[1] - ny * halfWidth],
    [p1[0] + nx * halfWidth, p1[1] + ny * halfWidth]
  ]

  // Terrain normal at the block centre. The block is extruded along this
  // normal so its side faces stand at 90° to the terrain surface on slopes:
  // the top follows the terrain raised by the wall height and the bottom
  // follows it embedded just below the surface.
  const cxm = (corners[0][0] + corners[2][0]) / 2
  const cym = (corners[0][1] + corners[2][1]) / 2
  const step = Math.max(0.5, len / 2)
  const zc = zOf(cxm, cym)
  const zx = zOf(cxm + step, cym)
  const zy = zOf(cxm, cym + step)
  let nxn = 0
  let nyn = 0
  let nzn = 1
  if (Number.isFinite(zc) && Number.isFinite(zx) && Number.isFinite(zy)) {
    const gx = (zx - zc) / step
    const gy = (zy - zc) / step
    const gn = Math.hypot(gx, gy, 1)
    if (gn > 1e-12) {
      nxn = -gx / gn
      nyn = -gy / gn
      nzn = 1 / gn
    }
  }
  const embed = 0.1
  const bottomZs = corners.map(([cx, cy]) => zOf(cx, cy) - embed * nzn)
  const topZs = corners.map(([cx, cy]) => zOf(cx, cy) + height * nzn)

  const positions: number[] = []
  const faces: number[] = []
  const push = (v: number[]): number => {
    const i = positions.length / 3
    positions.push(v[0], v[1], v[2])
    return i
  }
  const tri = (a: number, b: number, c: number) => faces.push(a, b, c)
  const triFlipped = (a: number, b: number, c: number) => faces.push(a, c, b)

  const i0 = push([corners[0][0] - nxn * embed, corners[0][1] - nyn * embed, bottomZs[0]])
  const i1 = push([corners[1][0] - nxn * embed, corners[1][1] - nyn * embed, bottomZs[1]])
  const i2 = push([corners[2][0] - nxn * embed, corners[2][1] - nyn * embed, bottomZs[2]])
  const i3 = push([corners[3][0] - nxn * embed, corners[3][1] - nyn * embed, bottomZs[3]])
  const i4 = push([corners[0][0] + nxn * height, corners[0][1] + nyn * height, topZs[0]])
  const i5 = push([corners[1][0] + nxn * height, corners[1][1] + nyn * height, topZs[1]])
  const i6 = push([corners[2][0] + nxn * height, corners[2][1] + nyn * height, topZs[2]])
  const i7 = push([corners[3][0] + nxn * height, corners[3][1] + nyn * height, topZs[3]])

  // bottom
  triFlipped(i0, i1, i2)
  triFlipped(i0, i2, i3)
  // top
  tri(i4, i6, i5)
  tri(i4, i7, i6)
  // sides
  tri(i0, i5, i1)
  tri(i0, i4, i5)
  tri(i1, i6, i2)
  tri(i1, i5, i6)
  tri(i2, i7, i3)
  tri(i2, i6, i7)
  tri(i3, i4, i0)
  tri(i3, i7, i4)

  return new Mesh({
    vertexAttributes: { position: new Float64Array(positions) },
    components: [{ faces }],
    spatialReference: sr
  })
}

/** Administrative level of a boundary polygon layer. */
type AdminLevel = 'village' | 'district' | 'city' | 'province' | 'country'

/**
 * Number of raised dots placed between two dashes for each admin level, the
 * tactile code: village = dash-4-dots, district = dash-3-dots, city = dash-2
 * dots, province = dash-1-dot, country = dash-dash (no dots).
 */
const ADMIN_LEVEL_DOTS: Record<AdminLevel, number> = {
  village: 4,
  district: 3,
  city: 2,
  province: 1,
  country: 0
}

/**
 * Detects the administrative level from a layer title. Most specific keywords
 * (country/province) are matched first, then village/district/city. Layers with
 * no recognizable keyword default to 'district' (dash-3-dots).
 */
function detectAdminLevel(title: string): AdminLevel {
  const t = (title || '').toLowerCase()
  if (/negara|country|nation/.test(t)) return 'country'
  if (/provinsi|province/.test(t)) return 'province'
  if (/desa|kelurahan|kampung|village/.test(t)) return 'village'
  if (/kecamatan|distrik|subdistrict/.test(t)) return 'district'
  if (/kabupaten|kota|kotamadya|regency|city/.test(t)) return 'city'
  return 'district'
}

/**
 * Builds a dash-dot wall along a ring as distinct 3D blocks: each dash is a
 * long rectangular box and each dot is a shorter box, separated by
 * configurable gaps. Each admin level uses a tactile code — the number of dots
 * between dashes (dash-N-dots): village = 4, district = 3, city = 2,
 * province = 1, country = 0 (plain dash-dash). Block dimensions come from the
 * per-level wall config.
 */
function buildDashDotWallFromRing(
  ring: Array<[number, number]>,
  terrain: Mesh | null,
  fallbackZ: number,
  sr: any,
  sampler: TerrainSampler | null,
  level: AdminLevel,
  cfg: AdminLevelWallConfig,
  closed: boolean = true
): Mesh | null {
  const dotsPerGap = ADMIN_LEVEL_DOTS[level]
  const { height, halfWidth, dashLength, dotLength, gap } = cfg

  let total = ring.reduce((acc, p, i) => {
    if (i === 0) return 0
    const q = ring[i - 1]
    return acc + Math.hypot(p[0] - q[0], p[1] - q[1])
  }, 0)
  if (closed) {
    total += Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1])
  }
  if (total <= 0 || ring.length < 2) return null

  const effectiveSampler = sampler !== undefined ? sampler : (terrain ? new TerrainSampler(terrain) : null)
  const zOf = (x: number, y: number): number => {
    if (effectiveSampler) {
      const z = effectiveSampler.heightAt(x, y)
      if (z !== null && Number.isFinite(z)) return z
    }
    return fallbackZ
  }

  const meshes: Mesh[] = []
  const unit = dashLength + gap + dotsPerGap * (dotLength + gap)
  const count = Math.max(1, Math.floor(total / unit))
  for (let k = 0; k < count; k++) {
    let s = k * unit
    const dashEnd = s + dashLength
    if (dashEnd > total) break
    const dash = buildDashDotBlock(ring, total, s, dashEnd, halfWidth, height, zOf, sr)
    if (dash) meshes.push(dash)
    s = dashEnd + gap
    for (let d = 0; d < dotsPerGap; d++) {
      const dotEnd = s + dotLength
      if (dotEnd > total) break
      const dot = buildDashDotBlock(ring, total, s, dotEnd, halfWidth, height, zOf, sr)
      if (dot) meshes.push(dot)
      s = dotEnd + gap
    }
  }

  if (meshes.length === 0) return null
  return meshes.length === 1 ? meshes[0] : merge(meshes)
}

/**
 * Queries division/province (polygon) feature layers that intersect the drawn
 * rectangle and raises their boundary lines as thin walls. Returns one merged
 * mesh (or null if no polygon layers produced geometry).
 */
/**
 * Splits a clipped polygon ring into open sub-paths that exclude the segments
 * lying exactly on the rectangle (AOI) boundary. Clipping an admin polygon that
 * extends past the drawn rectangle produces ring segments that run along the
 * rectangle edges; those should not be raised as boundary walls.
 * Returns an array of open polylines (each >= 2 points).
 */
function splitRingExcludingRectangleEdges(
  ring: Array<[number, number]>,
  extent: any
): Array<Array<[number, number]>> {
  const tol = Math.max(1e-6, (extent.width + extent.height) * 1e-9)
  const edges: Array<{ axis: 0 | 1, value: number }> = [
    { axis: 0, value: extent.xmin },
    { axis: 0, value: extent.xmax },
    { axis: 1, value: extent.ymin },
    { axis: 1, value: extent.ymax }
  ]
  const onEdge = (p: [number, number]): boolean =>
    edges.some((e) => Math.abs(p[e.axis] - e.value) <= tol)

  const isEdgeSegment = (a: [number, number], b: [number, number]): boolean => {
    if (!onEdge(a) || !onEdge(b)) return false
    // Both endpoints on the same rectangle edge line.
    return edges.some((e) =>
      Math.abs(a[e.axis] - e.value) <= tol && Math.abs(b[e.axis] - e.value) <= tol
    )
  }

  const subPaths: Array<Array<[number, number]>> = []
  let current: Array<[number, number]> = []
  const flush = () => {
    if (current.length >= 2) subPaths.push(current)
    current = []
  }

  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    if (isEdgeSegment(a, b)) {
      flush()
      continue
    }
    if (current.length === 0 || current[current.length - 1] !== a) {
      current.push(a)
    }
    current.push(b)
  }
  flush()

  return subPaths
}

async function buildDivisionBoundaryWalls(view: SceneView, rectangle: Polygon, terrain: Mesh | null, config: Config): Promise<Mesh | null> {
  const viewSR = view.spatialReference
  const meshes: Mesh[] = []
  const fallbackZ = terrain ? minZOf(terrain) : (config.baseZ0 ?? 0)

  const query = new Query({
    geometry: rectangle,
    spatialRelationship: 'intersects',
    returnGeometry: true,
    outFields: ['*']
  })

  // Wall centerline paths (with their half-width) used to keep Braille labels
  // clear of every division wall, and pending label jobs collected per feature.
  const wallPaths: Array<{ path: Array<[number, number]>, halfWidth: number }> = []
  const labelJobs: Array<{ name: string, rings: Array<Array<[number, number]>> }> = []

  const levels: AdminLevelKey[] = ['village', 'district', 'city', 'province', 'country']
  for (const level of levels) {
    const cfg = adminWallCfgMeters(config.adminLevels?.[level] ?? DEFAULT_ADMIN_LEVELS[level], rectangle.extent, config)
    if (!cfg.enabled) {
      console.log('[stl-export] polygon walls: level', level, 'disabled, skipping')
      continue
    }
    const explicit = !!cfg.layerId && cfg.layerId !== LINE_LAYER_NONE
    for (const layer of view.map.allLayers) {
      const lyr = layer as any
      if (typeof lyr.queryFeatures !== 'function') continue
      const gType = (lyr.geometryType || '').toLowerCase()
      if (gType !== 'polygon') {
        console.log('[stl-export] polygon walls: skip layer', lyr.title, 'type =', lyr.geometryType)
        continue
      }
      if (explicit) {
        if (lyr.id !== cfg.layerId) {
          console.log('[stl-export] polygon walls: layer', lyr.title, '!= explicit id for', level)
          continue
        }
      } else {
        if (!layerSelected(lyr, config)) {
          console.log('[stl-export] polygon walls: layer not selected, skipping', lyr.title)
          continue
        }
        if (detectAdminLevel(lyr.title) !== level) {
          console.log('[stl-export] polygon walls: layer', lyr.title, 'does not match level', level)
          continue
        }
      }

      let layerView: any
      try {
        layerView = await view.whenLayerView(lyr)
      } catch (e) {
        console.warn('[stl-export] polygon walls: no layer view for', lyr.title, e)
        continue
      }

      try {
        const result = await layerView.queryFeatures(query)
        console.log('[stl-export] polygon walls: queried', lyr.title, 'as', level, '=>', result.features.length, 'features')
        const sampler = terrain ? new TerrainSampler(terrain) : null
        for (const feature of result.features) {
          const geom = (feature as any).geometry
          if (!geom || !geom.rings) continue
          const projected = geom.spatialReference && !geom.spatialReference.equals(viewSR)
            ? (projectOperator.execute(geom, viewSR) as any)
            : geom
          if (!projected || !projected.rings) continue

          let clippedGeom = projected
          try {
            clippedGeom = geometryEngine.clip(projected, rectangle.extent) as any
          } catch (e) {
            console.warn('[stl-export] polygon walls: clip failed', lyr.title, e)
          }
          if (!clippedGeom || !clippedGeom.rings) continue

          for (const ring of clippedGeom.rings) {
            const flat: Array<[number, number]> = ring.map((p: any) => [p[0], p[1]] as [number, number])
            const subPaths = splitRingExcludingRectangleEdges(flat, rectangle.extent)
            if (subPaths.length === 0) continue
            const hadEdgeCut = subPaths.length > 1 || subPaths[0].length < flat.length
            if (!hadEdgeCut) {
              const wall = buildDashDotWallFromRing(flat, terrain, fallbackZ, viewSR, sampler, level, cfg, true)
              if (wall) meshes.push(wall)
              wallPaths.push({ path: flat, halfWidth: cfg.halfWidth })
              continue
            }
            for (const sub of subPaths) {
              const wall = buildDashDotWallFromRing(sub, terrain, fallbackZ, viewSR, sampler, level, cfg, false)
              if (wall) meshes.push(wall)
              wallPaths.push({ path: sub, halfWidth: cfg.halfWidth })
            }
          }

          if (config.includeLabels && config.includeLayerLabels !== false && (config.labelDomeHeight ?? 0.5) > 0 && (config.labelFontSize ?? 2.5) > 0) {
            const name = detectNameField((feature as any).attributes)
            if (name) {
              const rings: Array<Array<[number, number]>> = clippedGeom.rings.map((r: any) =>
                r.map((p: any) => [p[0], p[1]] as [number, number])
              )
              labelJobs.push({ name, rings })
            }
          }
        }
      } catch (e) {
        console.warn('[stl-export] polygon walls: query failed', lyr.title, e)
      }
    }
  }

  if (config.includeLabels && config.includeLayerLabels !== false && (config.labelDomeHeight ?? 0.5) > 0 && (config.labelFontSize ?? 2.5) > 0) {
    const extent = rectangle.extent
    const m = brailleMetrics(config.labelFontSize ?? 2.5)
    const labelH = mmToMeters(config.labelDomeHeight ?? 0.5, extent, config)
    const labelR = mmToMeters(m.radius, extent, config)
    const labelPitch = mmToMeters(m.pitch, extent, config)
    const labelCell = mmToMeters(m.cellSpacing, extent, config)
    for (const job of labelJobs) {
      const ext = brailleLabelExtents(job.name, labelPitch, labelCell)
      const halfW = ext.width / 2
      const halfH = ext.height / 2
      const gap = Math.max(labelR, 0.5)
      const edgeGap = mmToMeters(config.labelEdgeGap ?? 5, extent, config)
      const pt = findLabelPlacement(job.rings, rectangle.extent, wallPaths, halfW, halfH, gap, edgeGap)
      if (!pt) {
        console.log('[stl-export] label dropped:', job.name, 'labelW(m)=', ext.width, 'AOIW(m)=', extent.width)
        continue
      }
      const label = buildBrailleLabelMesh(
        pt.x,
        pt.y,
        job.name,
        terrain,
        fallbackZ,
        labelH,
        labelR,
        labelPitch,
        labelCell,
        viewSR
      )
      if (label) meshes.push(label)
    }
  }

  if (meshes.length === 0) return null
  return merge(meshes)
}

// ---------------------------------------------------------------------------
// Layout preview data (2D layers + label positions) for the static preview.
// ---------------------------------------------------------------------------

export interface LayoutPreviewData {
  /** Clipped admin division ring outlines in ground coords (for the AOI). */
  outlines: Array<Array<[number, number]>>
  /** Braille label anchor positions in ground coords. */
  labels: Array<{ x: number, y: number }>
}

/**
 * Queries the enabled admin polygon levels inside the AOI and returns their
 * clipped outlines plus the Braille label anchor positions (the same
 * placement algorithm the exporter uses). Used by the static layout preview.
 */
export async function computeLayoutPreviewData(
  view: SceneView,
  rectangle: Polygon,
  config: Config
): Promise<LayoutPreviewData> {
  const viewSR = view.spatialReference
  const outlines: Array<Array<[number, number]>> = []
  const labels: Array<{ x: number, y: number }> = []
  const wallPaths: Array<{ path: Array<[number, number]>, halfWidth: number }> = []
  const labelJobs: Array<{ name: string, rings: Array<Array<[number, number]>> }> = []

  const query = new Query({
    geometry: rectangle,
    spatialRelationship: 'intersects',
    returnGeometry: true,
    outFields: ['*']
  })

  const levels: AdminLevelKey[] = ['village', 'district', 'city', 'province', 'country']
  for (const level of levels) {
    const cfg = adminWallCfgMeters(config.adminLevels?.[level] ?? DEFAULT_ADMIN_LEVELS[level], rectangle.extent, config)
    if (!cfg.enabled) continue
    const explicit = !!cfg.layerId && cfg.layerId !== LINE_LAYER_NONE
    for (const layer of view.map.allLayers) {
      const lyr = layer as any
      if (typeof lyr.queryFeatures !== 'function') continue
      const gType = (lyr.geometryType || '').toLowerCase()
      if (gType !== 'polygon') continue
      if (explicit) {
        if (lyr.id !== cfg.layerId) continue
      } else {
        if (!layerSelected(lyr, config)) continue
        if (detectAdminLevel(lyr.title) !== level) continue
      }
      let layerView: any
      try {
        layerView = await view.whenLayerView(lyr)
      } catch (e) {
        continue
      }
      try {
        const result = await layerView.queryFeatures(query)
        for (const feature of result.features) {
          const geom = (feature as any).geometry
          if (!geom || !geom.rings) continue
          const projected = geom.spatialReference && !geom.spatialReference.equals(viewSR)
            ? (projectOperator.execute(geom, viewSR) as any)
            : geom
          if (!projected || !projected.rings) continue
          let clippedGeom = projected
          try {
            clippedGeom = geometryEngine.clip(projected, rectangle.extent) as any
          } catch (e) {
            continue
          }
          if (!clippedGeom || !clippedGeom.rings) continue
          for (const ring of clippedGeom.rings) {
            const flat: Array<[number, number]> = ring.map((p: any) => [p[0], p[1]] as [number, number])
            const subPaths = splitRingExcludingRectangleEdges(flat, rectangle.extent)
            for (const sub of subPaths) {
              wallPaths.push({ path: sub, halfWidth: cfg.halfWidth })
              outlines.push(sub)
            }
          }
          if (config.includeLabels && config.includeLayerLabels !== false && (config.labelDomeHeight ?? 0.5) > 0 && (config.labelFontSize ?? 2.5) > 0) {
            const name = detectNameField((feature as any).attributes)
            if (name) {
              const rings: Array<Array<[number, number]>> = clippedGeom.rings.map((r: any) =>
                r.map((p: any) => [p[0], p[1]] as [number, number])
              )
              labelJobs.push({ name, rings })
            }
          }
        }
      } catch (e) {
        console.warn('[stl-export] layout preview query failed', lyr.title, e)
      }
    }
  }

  if (config.includeLabels && config.includeLayerLabels !== false && (config.labelDomeHeight ?? 0.5) > 0 && (config.labelFontSize ?? 2.5) > 0) {
    const extent = rectangle.extent
    const m = brailleMetrics(config.labelFontSize ?? 2.5)
    const labelPitch = mmToMeters(m.pitch, extent, config)
    const labelCell = mmToMeters(m.cellSpacing, extent, config)
    const labelR = mmToMeters(m.radius, extent, config)
    for (const job of labelJobs) {
      const ext = brailleLabelExtents(job.name, labelPitch, labelCell)
      const halfW = ext.width / 2
      const halfH = ext.height / 2
      const gap = Math.max(labelR, 0.5)
      const edgeGap = mmToMeters(config.labelEdgeGap ?? 5, extent, config)
      const pt = findLabelPlacement(job.rings, rectangle.extent, wallPaths, halfW, halfH, gap, edgeGap)
      if (!pt) continue
      labels.push({ x: pt.x, y: pt.y })
    }
  }

  return { outlines, labels }
}

// ---------------------------------------------------------------------------
// Raster (tsunami hazard) contour bands.
// ---------------------------------------------------------------------------

async function buildRasterBands(view: SceneView, rectangle: Polygon, terrain: Mesh | null, config: Config): Promise<Mesh | null> {
  const viewSR = view.spatialReference
  const extent = rectangle.extent
  const grid = config.rasterGrid
  const bandMeshes: Mesh[] = []
  const fallbackZ = terrain ? minZOf(terrain) : (config.baseZ0 ?? 0)

  const layerQueue: any[] = [...view.map.allLayers]
  while (layerQueue.length > 0) {
    const layer = layerQueue.shift()
    const lyr = layer as any
    if (!lyr) continue
    const subs = (lyr as any).sublayers
    if (subs && typeof subs.forEach === 'function') {
      subs.forEach((s: any) => layerQueue.push(s))
    } else if (subs && Array.isArray(subs)) {
      subs.forEach((s: any) => layerQueue.push(s))
    }
    if (typeof lyr.getSamples !== 'function') {
      console.log('[stl-export] raster bands: skip layer', lyr.title, 'no getSamples')
      continue
    }
    if (!layerSelected(lyr, config)) {
      console.log('[stl-export] raster bands: layer not selected, skipping', lyr.title)
      continue
    }
    if (config.hazardLayerId && config.hazardLayerId !== LINE_LAYER_NONE && lyr.id !== config.hazardLayerId) {
      console.log('[stl-export] raster bands: layer', lyr.title, '!= hazard layer, skipping')
      continue
    }

    const cols = grid
    const rows = grid
    const cellW = extent.width / cols
    const cellH = extent.height / rows

    const locations: Array<{ x: number, y: number, spatialReference: any }> = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        locations.push({
          x: extent.xmin + (c + 0.5) * cellW,
          y: extent.ymin + (r + 0.5) * cellH,
          spatialReference: viewSR
        })
      }
    }

    let samples: any[] = []
    try {
      const result = await (lyr as any).getSamples({
        geometry: { type: 'multipoint', points: locations.map((l) => [l.x, l.y]), spatialReference: viewSR },
        returnFirstValueOnly: true
      })
      samples = (result && result.samples) || []
      console.log('[stl-export] raster bands: sampled', lyr.title, '=>', samples.length, 'samples')
    } catch (e) {
      console.warn('[stl-export] raster bands: getSamples failed for', lyr.title, e)
      continue
    }
    if (samples.length === 0) continue

    // Collect first-band values to compute the min/max range.
    const values: number[] = []
    for (const s of samples) {
      const pv = s && s.pixelValue
      const v = pv ? pv[0] : NaN
      values.push(Number.isFinite(v) ? v : NaN)
    }
    const finite = values.filter((v) => Number.isFinite(v))
    if (finite.length < 2) {
      console.warn('[stl-export] raster bands: not enough finite values for', lyr.title)
      continue
    }
    let vMin = Infinity
    let vMax = -Infinity
    for (const v of finite) {
      if (v < vMin) vMin = v
      if (v > vMax) vMax = v
    }
    const vSpan = vMax - vMin
    const bandCount = Math.max(1, Math.floor(config.rasterBands))
    const bandHeightsMm = config.rasterBandHeights ?? []
    const hasPerBand = bandHeightsMm.length > 0 && bandHeightsMm.some((h) => h > 0)
    const topHeightM = mmToMeters(config.rasterMaxHeight ?? 1.6, rectangle.extent, config)

    let built = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = values[r * cols + c]
        if (!Number.isFinite(v)) continue
        const t = vSpan > 0 ? (v - vMin) / vSpan : 0
        let band = Math.floor(t * bandCount)
        if (band >= bandCount) band = bandCount - 1
        if (band < 0) band = 0
        if (band === 0) continue
        const cellCX = extent.xmin + (c + 0.5) * cellW
        const cellCY = extent.ymin + (r + 0.5) * cellH
        const baseZ = terrain ? (terrainHeightAt(terrain, cellCX, cellCY) ?? fallbackZ) : fallbackZ
        const bandHeightM = hasPerBand && bandHeightsMm[band] > 0
          ? mmToMeters(bandHeightsMm[band], rectangle.extent, config)
          : (band / bandCount) * topHeightM
        const zTop = baseZ + bandHeightM
        const x0 = extent.xmin + c * cellW
        const y0 = extent.ymin + r * cellH
        const ring: Array<[number, number]> = [
          [x0, y0],
          [x0 + cellW, y0],
          [x0 + cellW, y0 + cellH],
          [x0, y0 + cellH]
        ]
        const slab = buildRingSlab([ring], baseZ, zTop, viewSR)
        if (slab) {
          bandMeshes.push(slab)
          built++
        }

        // Texture dots: higher hazard -> larger/taller dots. Spread them in a
        // small grid on top of the cell so the severity reads by touch.
        if (config.hazardDots !== false && slab) {
          const perCell = Math.max(1, Math.floor(config.hazardDotsPerCell || 3))
          const frac = (band + 1) / bandCount
          const dotR = mmToMeters(config.hazardDotRadius ?? 0.2, rectangle.extent, config) * (0.4 + 0.6 * frac)
          const dotH = mmToMeters(config.hazardDotHeight ?? 0.24, rectangle.extent, config) * (0.4 + 0.6 * frac)
          const pad = cellW * 0.15
          const innerW = cellW - pad * 2
          const innerH = cellH - pad * 2
          for (let di = 0; di < perCell; di++) {
            for (let dj = 0; dj < perCell; dj++) {
              const dx = pad + (innerW * (di + 0.5)) / perCell
              const dy = pad + (innerH * (dj + 0.5)) / perCell
              const dome = buildDomeMesh(x0 + dx, y0 + dy, zTop, dotR, dotH, viewSR)
              if (dome) bandMeshes.push(dome)
            }
          }
        }
      }
    }
    console.log('[stl-export] raster bands: built', built, 'cell slabs for', lyr.title)
  }

  if (bandMeshes.length === 0) return null
  console.log('[stl-export] raster bands: merging', bandMeshes.length, 'cell meshes')
  return merge(bandMeshes)
}

// ---------------------------------------------------------------------------
// Disaster related vector layers (polygon, polyline, point). One layer of each
// feature type can be designated; the parameters used depend on the type.
// ---------------------------------------------------------------------------

async function buildDisasterVectorLayers(view: SceneView, rectangle: Polygon, terrain: Mesh | null, config: Config): Promise<Mesh | null> {
  const viewSR = view.spatialReference
  const meshes: Mesh[] = []
  const fallbackZ = terrain ? minZOf(terrain) : (config.baseZ0 ?? 0)

  const query = new Query({
    geometry: rectangle,
    spatialRelationship: 'intersects',
    returnGeometry: true,
    outFields: ['*']
  })

  const polygonId = config.disasterPolygonLayerId
  const polylineId = config.disasterPolylineLayerId
  const pointId = config.disasterPointLayerId
  const includePolygon = polygonId && polygonId !== LINE_LAYER_NONE
  const includePolyline = polylineId && polylineId !== LINE_LAYER_NONE
  const includePoint = pointId && pointId !== LINE_LAYER_NONE

  const layerQueue: any[] = [...view.map.allLayers]
  while (layerQueue.length > 0) {
    const layer = layerQueue.shift()
    const lyr = layer as any
    if (!lyr) continue
    const subs = (lyr as any).sublayers
    if (subs && typeof subs.forEach === 'function') {
      subs.forEach((s: any) => layerQueue.push(s))
    } else if (subs && Array.isArray(subs)) {
      subs.forEach((s: any) => layerQueue.push(s))
    }
    if (typeof lyr.queryFeatures !== 'function') continue
    const gType = (lyr.geometryType || '').toLowerCase()

    let role: 'polygon' | 'polyline' | 'point' | null = null
    if (gType === 'polygon' && includePolygon && lyr.id === polygonId) role = 'polygon'
    else if (gType === 'polyline' && includePolyline && lyr.id === polylineId) role = 'polyline'
    else if ((gType === 'point' || gType === 'multipoint') && includePoint && lyr.id === pointId) role = 'point'
    if (!role) {
      console.log('[stl-export] disaster vector: skip layer', lyr.title, 'type =', lyr.geometryType)
      continue
    }
    // The disaster layers are chosen explicitly in their own dropdowns, so the
    // "Scene layers" (export all / specific) selection must not filter them out.

    let layerView: any
    try {
      layerView = await view.whenLayerView(lyr)
    } catch (e) {
      console.warn('[stl-export] disaster vector: no layer view for', lyr.title, e)
      continue
    }

    try {
      const result = await layerView.queryFeatures(query)
      console.log('[stl-export] disaster vector: queried', lyr.title, '=>', result.features.length, 'features')

      if (role === 'polygon') {
        console.log('[stl-export] disaster polygon: terrain =', !!terrain, 'fallbackZ =', fallbackZ)
        const classField = config.disasterPolygonClassField || ''
        const classHeights = config.disasterPolygonClassHeights ?? {}
        const byClass: Record<string, Array<Array<Array<[number, number]>>>> = {}
        let defaultGroup: Array<Array<Array<[number, number]>>> = []
        for (const feature of result.features) {
          const geom = (feature as any).geometry
          if (!geom) continue
          const projected = geom.spatialReference && !geom.spatialReference.equals(viewSR)
            ? (projectOperator.execute(geom, viewSR) as any)
            : geom
          if (!projected) continue
          let clippedGeom = projected
          try {
            clippedGeom = geometryEngine.clip(projected, rectangle.extent) as any
          } catch (e) {
            console.warn('[stl-export] disaster vector: clip failed', lyr.title, e)
          }
          if (!clippedGeom || !clippedGeom.rings) continue
          const rings: Array<Array<[number, number]>> = clippedGeom.rings.map(
            (ringp: any) => ringp.map((p: any) => [p[0], p[1]] as [number, number])
          )
          const classVal = classField ? String((feature as any).attributes?.[classField] ?? '') : ''
          if (classField && classVal && classHeights[classVal] !== undefined) {
            if (!byClass[classVal]) byClass[classVal] = []
            byClass[classVal].push(rings)
          } else {
            defaultGroup.push(rings)
          }
        }
        if (defaultGroup.length > 0) byClass['__default__'] = defaultGroup
        if (Object.keys(byClass).length === 0) continue
        const defaultHeight = mmToMeters(config.disasterPolygonHeight ?? 0.6, rectangle.extent, config)
        for (const key of Object.keys(byClass)) {
          const height = key === '__default__'
            ? defaultHeight
            : mmToMeters(classHeights[key] ?? config.disasterPolygonHeight ?? 0.6, rectangle.extent, config)
          let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity
          for (const rg of byClass[key]) {
            for (const ring of rg) {
              for (const [x, y] of ring) {
                if (x < rMinX) rMinX = x
                if (y < rMinY) rMinY = y
                if (x > rMaxX) rMaxX = x
                if (y > rMaxY) rMaxY = y
              }
            }
          }
          console.log('[stl-export] disaster polygon: building class', key, 'rings =', byClass[key].length, 'height(m) =', height.toFixed(3), 'bounds x[' + rMinX + ',' + rMaxX + '] y[' + rMinY + ',' + rMaxY + ']')
          const area = buildDrapedPolygonArea(byClass[key], terrain, height, fallbackZ, viewSR)
          if (area) meshes.push(area)
        }
        continue
      }

      if (role === 'polyline') {
        const classField = config.disasterPolylineClassField || ''
        const classHeights = config.disasterPolylineClassHeights ?? {}
        const byClass: Record<string, Array<Array<[number, number]>>> = {}
        let defaultPaths: Array<Array<[number, number]>> = []
        for (const feature of result.features) {
          const geom = (feature as any).geometry
          if (!geom) continue
          const projected = geom.spatialReference && !geom.spatialReference.equals(viewSR)
            ? (projectOperator.execute(geom, viewSR) as any)
            : geom
          if (!projected) continue
          let clippedGeom = projected
          try {
            clippedGeom = geometryEngine.clip(projected, rectangle.extent) as any
          } catch (e) {
            console.warn('[stl-export] disaster vector: clip failed', lyr.title, e)
          }
          if (!clippedGeom) continue
          const paths: Array<Array<[number, number]>> = []
          if (clippedGeom.paths) {
            for (const path of clippedGeom.paths) {
              const flat: Array<[number, number]> = path.map((p: any) => [p[0], p[1]] as [number, number])
              if (flat.length >= 2) paths.push(flat)
            }
          }
          if (clippedGeom.rings) {
            for (const ringp of clippedGeom.rings) {
              const flat: Array<[number, number]> = ringp.map((p: any) => [p[0], p[1]] as [number, number])
              if (flat.length >= 2) paths.push(flat)
            }
          }
          const classVal = classField ? String((feature as any).attributes?.[classField] ?? '') : ''
          if (classField && classVal && classHeights[classVal] !== undefined) {
            if (!byClass[classVal]) byClass[classVal] = []
            byClass[classVal].push(...paths)
          } else {
            defaultPaths.push(...paths)
          }
        }
        if (defaultPaths.length > 0) byClass['__default__'] = defaultPaths
        if (Object.keys(byClass).length === 0) continue
        const halfWidth = mmToMeters(config.disasterWallHalfWidth ?? 0.1, rectangle.extent, config)
        const defaultWallHeight = mmToMeters(config.disasterWallHeight ?? 0.6, rectangle.extent, config)
        for (const key of Object.keys(byClass)) {
          const paths = byClass[key]
          if (paths.length === 0) continue
          const wallHeight = key === '__default__'
            ? defaultWallHeight
            : mmToMeters(classHeights[key] ?? config.disasterWallHeight ?? 0.6, rectangle.extent, config)
          let wall: Mesh | null
          if (terrain) {
            wall = buildDrapedLineWallsFromPaths(paths, halfWidth, terrain, wallHeight, fallbackZ, viewSR)
          } else {
            const baseZ = linePathsBaseZ(paths, terrain, fallbackZ)
            wall = buildLineWallFromPaths(paths, halfWidth, baseZ, baseZ + wallHeight, viewSR)
          }
          if (wall) meshes.push(wall)
        }
        continue
      }

      // role === 'point'
      const classField = config.disasterPointClassField || ''
      const classHeights = config.disasterPointClassHeights ?? {}
      const radius = mmToMeters(config.disasterPointRadius ?? 0.3, rectangle.extent, config)
      const defaultPointHeight = mmToMeters(config.disasterPointHeight ?? 0.5, rectangle.extent, config)
      let built = 0
      for (const feature of result.features) {
        const geom = (feature as any).geometry
        if (!geom) continue
        const projected = geom.spatialReference && !geom.spatialReference.equals(viewSR)
          ? (projectOperator.execute(geom, viewSR) as any)
          : geom
        if (!projected) continue
        const pts = projected.points ? projected.points : projected.type === 'point' ? [[projected.x, projected.y]] : []
        const classVal = classField ? String((feature as any).attributes?.[classField] ?? '') : ''
        const pointHeight = classField && classVal && classHeights[classVal] !== undefined
          ? mmToMeters(classHeights[classVal], rectangle.extent, config)
          : defaultPointHeight
        for (const p of pts) {
          const x = p[0]
          const y = p[1]
          if (x < rectangle.extent.xmin || x > rectangle.extent.xmax || y < rectangle.extent.ymin || y > rectangle.extent.ymax) continue
          const baseZ = terrain ? (terrainHeightAt(terrain, x, y) ?? fallbackZ) : fallbackZ
          const dome = buildDomeMesh(x, y, baseZ, radius, pointHeight, viewSR)
          if (dome) {
            meshes.push(dome)
            built++
          }
        }
      }
      console.log('[stl-export] disaster vector: built', built, 'point domes for', lyr.title)
    } catch (e) {
      console.warn('[stl-export] disaster vector: query failed', lyr.title, e)
    }
  }

  if (meshes.length === 0) return null
  console.log('[stl-export] disaster vector: merging', meshes.length, 'meshes')
  return merge(meshes)
}

/**
 * Queries all scene layers in the map that intersect the drawn rectangle and
 * returns their mesh geometries (projected into the view spatial reference).
 */
async function querySceneLayerMeshes(view: SceneView, rectangle: Polygon, config: Config): Promise<Mesh[]> {
  const viewSR = view.spatialReference
  const meshes: Mesh[] = []

  const query = new Query({
    geometry: rectangle,
    spatialRelationship: 'intersects',
    returnGeometry: true,
    outFields: ['*']
  })

  for (const layer of view.map.allLayers) {
    const lyr = layer as any
    if (lyr.type !== 'scene' && lyr.type !== 'building' && lyr.type !== 'point-cloud') {
      console.log('[stl-export] skip layer', lyr.title, 'type =', lyr.type)
      continue
    }
    if (!layerSelected(lyr, config)) {
      console.log('[stl-export] layer not selected, skipping', lyr.title)
      continue
    }

    try {
      await lyr.load()
    } catch (e) {
      console.warn('[stl-export] Failed to load layer', lyr.title, e)
      continue
    }

    let layerView: any
    try {
      layerView = await view.whenLayerView(lyr)
    } catch (e) {
      console.warn('[stl-export] no layer view for', lyr.title, e)
      continue
    }

    try {
      const result = await layerView.queryFeatures(query)
      console.log('[stl-export] queried', lyr.title, '=>', result.features.length, 'features')
      for (const feature of result.features) {
        const geom = (feature as any).geometry
        if (!isMeshGeometry(geom)) {
          console.log('[stl-export]   feature geometry type =', geom?.type, 'not mesh')
          continue
        }

        try {
          await (geom as Mesh).load()
        } catch (e) {
          console.warn('[stl-export]   mesh load failed', lyr.title, JSON.stringify(e))
          continue
        }
        const pos = (geom as Mesh).vertexAttributes.position
        console.log('[stl-export]   mesh loaded, vertices =', pos ? pos.length / 3 : 0)
        if (!hasValidPositions(geom as Mesh)) {
          console.warn('[stl-export]   mesh has invalid/garbage vertices, skipping', lyr.title)
          continue
        }

        const projected = geom.spatialReference.equals(viewSR)
          ? geom
          : (projectOperator.execute(geom, viewSR) as Mesh | null)
        if (!projected) continue

        let candidate = projected
        if (config.simplifyMeshes !== false) {
          const tol = mmToMeters(config.simplifyCell ?? 0.1, rectangle.extent, config)
          candidate = simplifyMeshByClustering(candidate, tol)
        }

        const clipped = clipMeshToRectangle(candidate, rectangle.extent)
        if (clipped) {
          meshes.push(clipped)
        } else {
          console.log('[stl-export]   mesh fully outside the rectangle after clipping, skipping', lyr.title)
        }
      }
    } catch (e) {
      console.warn('[stl-export] Failed to query layer view', lyr.title, JSON.stringify(e))
    }
  }

  return meshes
}

/**
 * Extrudes a terrain mesh downward to a flat base to make the model watertight
 * and printable. Adds side walls along the mesh boundary and a flat bottom cap.
 */
function extrudeTerrain(mesh: Mesh, depth: number): Mesh {
  const positions = mesh.vertexAttributes.position
  const vertexCount = positions.length / 3
  if (vertexCount === 0) return mesh

  const components = mesh.components && mesh.components.length > 0
    ? mesh.components
    : [{ faces: null }]

  const triangles: number[] = []
  for (const component of components) {
    const faces = component.faces
    if (faces && faces.length > 0) {
      for (let i = 0; i < faces.length; i++) triangles.push(faces[i])
    } else {
      for (let i = 0; i < vertexCount; i++) triangles.push(i)
    }
  }
  if (triangles.length % 3 !== 0) {
    triangles.length -= triangles.length % 3
  }

  let minZ = Infinity
  for (let i = 0; i < vertexCount; i++) {
    const z = positions[i * 3 + 2]
    if (z < minZ) minZ = z
  }
  const baseZ = minZ - depth

  const edgeCount = new Map<string, number>()
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t]
    const b = triangles[t + 1]
    const c = triangles[t + 2]
    const edges = [[a, b], [b, c], [c, a]]
    for (const [u, v] of edges) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1)
    }
  }

  const newPositions = new Float64Array((vertexCount * 2 + 4) * 3)
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3]
    const y = positions[i * 3 + 1]
    const z = positions[i * 3 + 2]
    newPositions[i * 3] = x
    newPositions[i * 3 + 1] = y
    newPositions[i * 3 + 2] = z
    newPositions[(vertexCount + i) * 3] = x
    newPositions[(vertexCount + i) * 3 + 1] = y
    newPositions[(vertexCount + i) * 3 + 2] = baseZ
  }

  const newFaces: number[] = []
  for (let i = 0; i < triangles.length; i++) newFaces.push(triangles[i])

  const seen = new Set<string>()
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = triangles[t]
    const b = triangles[t + 1]
    const c = triangles[t + 2]
    const edges = [[a, b], [b, c], [c, a]]
    for (const [u, v] of edges) {
      const key = u < v ? `${u}_${v}` : `${v}_${u}`
      if ((edgeCount.get(key) || 0) === 1 && !seen.has(key)) {
        seen.add(key)
        const uBottom = vertexCount + u
        const vBottom = vertexCount + v
        newFaces.push(u, uBottom, v)
        newFaces.push(uBottom, vBottom, v)
      }
    }
  }

  const extent = mesh.extent
  if (extent) {
    const ci = vertexCount * 2
    newPositions.set([extent.xmin, extent.ymin, baseZ], ci * 3)
    newPositions.set([extent.xmax, extent.ymin, baseZ], (ci + 1) * 3)
    newPositions.set([extent.xmax, extent.ymax, baseZ], (ci + 2) * 3)
    newPositions.set([extent.xmin, extent.ymax, baseZ], (ci + 3) * 3)
    newFaces.push(ci, ci + 2, ci + 1)
    newFaces.push(ci, ci + 3, ci + 2)
  }

  return new Mesh({
    vertexAttributes: { position: newPositions },
    components: [{ faces: newFaces }],
    spatialReference: mesh.spatialReference,
    vertexSpace: mesh.vertexSpace
  })
}

/**
 * Builds the final printable mesh for the given rectangle and returns it as a
 * binary STL blob.
 */
export async function exportScene(
  view: SceneView,
  rectangle: Polygon,
  config: Config
): Promise<ExportResult> {
  const meshes: Mesh[] = []
  let includedTerrain = false
  let terrainMesh: Mesh | null = null

  console.log('[stl-export] groundView =', !!view.groundView, 'sampler =', !!view.groundView?.elevationSampler)
  const layers = view.map.allLayers.map((l: any) => ({ title: l.title, type: l.type, hasQuery: typeof l.queryFeatures === 'function' }))
  console.log('[stl-export] map layers:', JSON.stringify(layers))

  if (config.includeTerrain) {
    const terrain = await createTerrainMesh(view, rectangle.extent)
    if (terrain) {
      const tp = terrain.vertexAttributes.position
      let nonFinite = 0, huge = 0
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
      for (let i = 0; i < tp.length; i += 3) {
        const x = tp[i], y = tp[i + 1], z = tp[i + 2]
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nonFinite++
        if (Math.abs(x) > 1e9 || Math.abs(y) > 1e9 || Math.abs(z) > 1e9) huge++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (z < minZ) minZ = z
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        if (z > maxZ) maxZ = z
      }
      console.log('[stl-export] terrain verts =', tp.length / 3, 'nonFinite =', nonFinite, 'huge =', huge, 'x[' + minX + ',' + maxX + '] y[' + minY + ',' + maxY + '] z[' + minZ + ',' + maxZ + ']')
      includedTerrain = true
      terrainMesh = hasValidPositions(terrain) ? terrain : sanitizeTerrain(terrain)
    } else {
      console.warn('[stl-export] terrain mesh was null')
    }
  }

  if (config.includeLayers) {
    const layerMeshes = await querySceneLayerMeshes(view, rectangle, config)
    console.log('[stl-export] layer meshes found:', layerMeshes.length)
    let bMin = Infinity, bMax = -Infinity
    for (const m of layerMeshes) {
      const p = m.vertexAttributes.position
      for (let i = 2; i < p.length; i += 3) {
        if (p[i] < bMin) bMin = p[i]
        if (p[i] > bMax) bMax = p[i]
      }
    }
    console.log('[stl-export] layer z range [' + bMin + ',' + bMax + ']')
    meshes.push(...layerMeshes)
  }

  if (terrainMesh) {
    if (config.includeLayers) {
      liftBuildingsToTerrain(meshes, terrainMesh)
      const pads = addFoundationPads(meshes, terrainMesh, meshes)
      if (pads > 0) {
        console.log('[stl-export] added foundation pads for floating buildings:', pads)
      }
    }
    meshes.push(config.extrudeBase ? extrudeTerrain(terrainMesh, mmToMeters(config.extrusionDepth ?? 2, rectangle.extent, config)) : terrainMesh)
  }

  if (config.includePolygons !== false) {
    const baseForFeatures = config.flatBase ? null : terrainMesh
    const walls = await buildDivisionBoundaryWalls(view, rectangle, baseForFeatures, config)
    if (walls) {
      console.log('[stl-export] division boundary walls:', walls.vertexAttributes.position.length / 3, 'verts')
      meshes.push(walls)
    }
  }

  if (config.includeLines !== false && (config.includeRoads !== false || config.includeRivers !== false)) {
    const baseForFeatures = config.flatBase ? null : terrainMesh
    const lineWalls = await buildLineFeatureWalls(view, rectangle, baseForFeatures, config)
    if (lineWalls) {
      console.log('[stl-export] line feature walls:', lineWalls.vertexAttributes.position.length / 3, 'verts')
      meshes.push(lineWalls)
    }
  }

  if (config.includeRaster !== false) {
    const baseForFeatures = config.flatBase ? null : terrainMesh
    const bands = await buildRasterBands(view, rectangle, baseForFeatures, config)
    if (bands) {
      console.log('[stl-export] raster bands:', bands.vertexAttributes.position.length / 3, 'verts')
      meshes.push(bands)
    }
    const disasterVector = await buildDisasterVectorLayers(view, rectangle, baseForFeatures, config)
    if (disasterVector) {
      console.log('[stl-export] disaster vector layers:', disasterVector.vertexAttributes.position.length / 3, 'verts')
      meshes.push(disasterVector)
    }
  }

  if (config.includeMargin !== false) {
    const frameZ = marginFrameZ(terrainMesh, config)
    const margins = layoutMarginsMeters(rectangle.extent, config)
    const frameMeshes = buildMarginFrame(rectangle, frameZ, terrainMesh, config, margins)
    for (const fm of frameMeshes) meshes.push(fm)

    if (config.includeLabels && config.includeFurnitureLabels !== false && config.includeTitle !== false && config.mapTitle && config.mapTitle.trim()) {
      const title = buildMarginTitle(rectangle, frameZ, config, margins)
      if (title) meshes.push(title)
    }

    if (config.includeScaleBar !== false) {
      const bar = buildMarginScaleBar(rectangle, frameZ, config, margins)
      if (bar) meshes.push(bar)
    }

    if (config.includeLabels && config.includeFurnitureLabels !== false && config.includePrintScale !== false) {
      const ps = buildMarginPrintScale(rectangle, frameZ, config, margins)
      if (ps) meshes.push(ps)
    }

    if (config.includeNorthArrow !== false) {
      const arrow = buildMarginNorthArrow(rectangle, frameZ, config, margins)
      if (arrow) meshes.push(arrow)
    }
  }

  if (config.flatBase || !terrainMesh) {
    const plate = buildFlatBase(rectangle, config)
    if (plate) {
      console.log('[stl-export] flat base plate:', plate.vertexAttributes.position.length / 3, 'verts')
      meshes.push(plate)
    }
  }

  if (meshes.length === 0) {
    throw new Error('No terrain or scene layers found inside the selected area.')
  }

  const merged = merge(meshes)
  if (!merged) {
    throw new Error('Failed to merge meshes.')
  }
  console.log('[stl-export] merged vertices =', merged.vertexAttributes.position.length / 3, 'components =', merged.components?.length)

  const center = rectangle.extent.center
  let minZ = Infinity
  const positions = merged.vertexAttributes.position
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] < minZ) minZ = positions[i + 2]
  }

  const bounds = (attr: Float32Array | Float64Array) => {
    let minX = Infinity, minY = Infinity, minZ2 = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < attr.length; i += 3) {
      const x = attr[i], y = attr[i + 1], z = attr[i + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ2) minZ2 = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
    return { minX, minY, minZ: minZ2, maxX, maxY, maxZ }
  }

  console.log('[stl-export] merged bounds:', JSON.stringify(bounds(positions)))
  const local = await convertVertexSpace(
    merged,
    new MeshLocalVertexSpace({ origin: [center.x, center.y, minZ] })
  )
  const localBounds = bounds(local.vertexAttributes.position)
  console.log('[stl-export] local bounds:', JSON.stringify(localBounds))

  const blob = meshToStl(local, 'scene-export')
  const preview = extractPreviewGeometry(local)

  return {
    blob,
    triangleCount: countTriangles(local),
    layerCount: meshes.length,
    includedTerrain,
    preview
  }
}
