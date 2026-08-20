import type Mesh from 'esri/geometry/Mesh'

const encoder = new TextEncoder()

/**
 * Writes a binary STL file from a Mesh. The mesh is expected to be in a
 * local (meter) vertex space so that the coordinates can be used directly
 * for 3D printing.
 *
 * @param mesh the mesh to serialize
 * @param modelName name written into the STL header
 * @returns a binary STL Blob ready to be downloaded
 */
export function meshToStl(mesh: Mesh, modelName: string): Blob {
  const positions = mesh.vertexAttributes.position
  const vertexCount = positions.length / 3

  const components = mesh.components && mesh.components.length > 0
    ? mesh.components
    : [{ faces: null }]

  const triangles: number[][] = []
  for (const component of components) {
    const faces = component.faces
    if (faces && faces.length > 0) {
      for (let i = 0; i < faces.length; i += 3) {
        triangles.push([faces[i], faces[i + 1], faces[i + 2]])
      }
    } else {
      for (let i = 0; i < vertexCount; i += 3) {
        triangles.push([i, i + 1, i + 2])
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
  const validTriangles = triangles.filter(([a, b, c]) => finiteIndex(a) && finiteIndex(b) && finiteIndex(c))

  const headerBytes = encoder.encode(modelName.slice(0, 79))
  const buffer = new ArrayBuffer(84 + validTriangles.length * 50)
  const dv = new DataView(buffer)

  for (let i = 0; i < headerBytes.length; i++) {
    dv.setUint8(i, headerBytes[i])
  }
  dv.setUint32(80, validTriangles.length, true)

  let offset = 84
  for (const [a, b, c] of validTriangles) {
    const ax = positions[a * 3]
    const ay = positions[a * 3 + 1]
    const az = positions[a * 3 + 2]
    const bx = positions[b * 3]
    const by = positions[b * 3 + 1]
    const bz = positions[b * 3 + 2]
    const cx = positions[c * 3]
    const cy = positions[c * 3 + 1]
    const cz = positions[c * 3 + 2]

    const ux = bx - ax
    const uy = by - ay
    const uz = bz - az
    const vx = cx - ax
    const vy = cy - ay
    const vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len > 0) {
      nx /= len
      ny /= len
      nz /= len
    }

    dv.setFloat32(offset, nx, true)
    dv.setFloat32(offset + 4, ny, true)
    dv.setFloat32(offset + 8, nz, true)
    offset += 12

    const vertices: Array<[number, number, number]> = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]
    for (const [x, y, z] of vertices) {
      dv.setFloat32(offset, x, true)
      dv.setFloat32(offset + 4, y, true)
      dv.setFloat32(offset + 8, z, true)
      offset += 12
    }
    dv.setUint16(offset, 0, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'model/stl' })
}

/**
 * Triggers a download of a Blob in the browser.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
