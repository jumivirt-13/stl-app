import type { PreviewGeometry } from './exportScene'

/**
 * Preview3D — a small dependency-free WebGL renderer for the STL export widget.
 *
 * Credits:
 *  - WebGL shader math and matrix helpers written by hand (no external libs).
 *  - Inspired by classic WebGL look-at / orbit-camera tutorials (e.g. the
 *    OpenGL lookAt camera and WebGLFundamentals.org lighting notes).
 *  - The geometry it displays is produced by the ArcGIS API for JavaScript
 *    (esri/geometry/support/meshUtils) during exportScene.ts.
 *
 * Uses a WebGL2 context when available with a WebGL1 fallback, and handles
 * both 32-bit and 16-bit element indices.
 */

const VERT_SRC = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uModelView;
uniform mat4 uProjection;
uniform mat3 uNormalMatrix;
varying vec3 vNormal;
varying vec3 vPos;
void main() {
  vNormal = uNormalMatrix * aNormal;
  vec4 mv = uModelView * vec4(aPosition, 1.0);
  vPos = mv.xyz;
  gl_Position = uProjection * mv;
}
`

const FRAG_SRC = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vPos;
uniform vec3 uLightDir;
uniform vec3 uColor;
uniform float uLight;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float diff = max(dot(n, normalize(uLightDir)), 0.0);
  float ambient = 0.35;
  float shade = ambient + (1.0 - ambient) * diff;
  float edge = abs(dot(n, normalize(vec3(0.0, 0.0, 1.0))));
  vec3 base = uColor * shade;
  if (edge < 0.22) base *= 0.82;
  gl_FragColor = vec4(base * uLight, 1.0);
}
`

/**
 * Minimal WebGL renderer for the exported triangle geometry with orbit
 * controls (drag to tilt/rotate, wheel to zoom, auto-rotate option). Avoids a
 * three.js dependency.
 */
export class Preview3D {
  private canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private isWebGL2 = false
  private program: WebGLProgram
  private positionBuf: WebGLBuffer
  private normalBuf: WebGLBuffer
  private indexBuf: WebGLBuffer
  private uModelView: WebGLUniformLocation
  private uProjection: WebGLUniformLocation
  private uNormalMatrix: WebGLUniformLocation
  private uLightDir: WebGLUniformLocation
  private uColor: WebGLUniformLocation
  private uLight: WebGLUniformLocation
  private geom: PreviewGeometry | null = null
  private indexCount = 0
  private indexType = 0
  private theta = -0.6
  private phi = 1.15
  private distance = 8
  private target = [0, 0, 0]
  private radius = 1
  private raf = 0
  private autoRotate = true
  private dragging = false
  private lastX = 0
  private lastY = 0
  private disposed = false
  private onFrame: (() => void) | null = null
  private color: [number, number, number] = [0.82, 0.87, 0.95]

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const gl2 = canvas.getContext('webgl2', { antialias: true, alpha: true }) as WebGLRenderingContext | null
    const gl = gl2 || canvas.getContext('webgl', { antialias: true, alpha: true })
    if (!gl) throw new Error('WebGL not supported')
    this.gl = gl
    this.isWebGL2 = !!gl2

    this.program = this.buildProgram(gl)
    gl.useProgram(this.program)
    this.positionBuf = gl.createBuffer()!
    this.normalBuf = gl.createBuffer()!
    this.indexBuf = gl.createBuffer()!

    const aPosition = gl.getAttribLocation(this.program, 'aPosition')
    const aNormal = gl.getAttribLocation(this.program, 'aNormal')
    gl.enableVertexAttribArray(aPosition)
    gl.enableVertexAttribArray(aNormal)

    this.uModelView = gl.getUniformLocation(this.program, 'uModelView')!
    this.uProjection = gl.getUniformLocation(this.program, 'uProjection')!
    this.uNormalMatrix = gl.getUniformLocation(this.program, 'uNormalMatrix')!
    this.uLightDir = gl.getUniformLocation(this.program, 'uLightDir')!
    this.uColor = gl.getUniformLocation(this.program, 'uColor')!
    this.uLight = gl.getUniformLocation(this.program, 'uLight')!

    gl.clearColor(1, 1, 1, 1)
    gl.enable(gl.DEPTH_TEST)
    // Culling disabled: merged STL meshes may have mixed winding order, so
    // render double-sided to guarantee the model is always visible.
    gl.disable(gl.CULL_FACE)

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })

    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
  }

  setGeometry(geom: PreviewGeometry | null): void {
    this.geom = geom
    if (!geom) {
      this.indexCount = 0
      return
    }
    const gl = this.gl
    this.indexCount = geom.indices.length

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuf)
    gl.bufferData(gl.ARRAY_BUFFER, geom.positions, gl.STATIC_DRAW)
    const aPosition = gl.getAttribLocation(this.program, 'aPosition')
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0)

    const normals = this.computeNormals(geom)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuf)
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW)
    const aNormal = gl.getAttribLocation(this.program, 'aNormal')
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0)

    // WebGL1 only supports 16-bit element indices unless OES_element_index_uint
    // is enabled, so remap to Uint16 when the vertex count allows it.
    const vertexCount = geom.positions.length / 3
    let indexData: ArrayBufferView = geom.indices
    let indexType: number = gl.UNSIGNED_INT
    if (!this.isWebGL2) {
      const ext = gl.getExtension('OES_element_index_uint')
      if (!ext && vertexCount < 65536) {
        indexData = new Uint16Array(geom.indices)
        indexType = gl.UNSIGNED_SHORT
      }
    }
    this.indexType = indexType

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW)

    const cx = (geom.minX + geom.maxX) / 2
    const cy = (geom.minY + geom.maxY) / 2
    const cz = (geom.minZ + geom.maxZ) / 2
    this.target = [cx, cy, cz]
    this.radius = Math.max(
      (geom.maxX - geom.minX) / 2,
      (geom.maxY - geom.minY) / 2,
      (geom.maxZ - geom.minZ) / 2,
      0.001
    )
    this.distance = this.radius * 2.6
    this.theta = -0.6
    this.phi = 1.15
  }

  setAutoRotate(v: boolean): void {
    this.autoRotate = v
  }

  /** Sets the model tint color as an [r, g, b] tuple (0..1). */
  setColor(c: [number, number, number]): void {
    this.color = c
  }

  setOnFrame(fn: (() => void) | null): void {
    this.onFrame = fn
  }

  private computeNormals(geom: PreviewGeometry): Float32Array {
    const n = new Float32Array(geom.positions.length)
    const idx = geom.indices
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3
      const b = idx[i + 1] * 3
      const c = idx[i + 2] * 3
      const ax = geom.positions[a], ay = geom.positions[a + 1], az = geom.positions[a + 2]
      const bx = geom.positions[b], by = geom.positions[b + 1], bz = geom.positions[b + 2]
      const cx = geom.positions[c], cy = geom.positions[c + 1], cz = geom.positions[c + 2]
      const ux = bx - ax, uy = by - ay, uz = bz - az
      const vx = cx - ax, vy = cy - ay, vz = cz - az
      let nx = uy * vz - uz * vy
      let ny = uz * vx - ux * vz
      let nz = ux * vy - uy * vx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (len > 0) {
        nx /= len
        ny /= len
        nz /= len
      }
      for (const v of [a, b, c]) {
        n[v] += nx
        n[v + 1] += ny
        n[v + 2] += nz
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const len = Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2])
      if (len > 0) {
        n[i] /= len
        n[i + 1] /= len
        n[i + 2] /= len
      }
    }
    return n
  }

  private loop(): void {
    if (this.disposed) return
    this.render()
    this.raf = requestAnimationFrame(this.loop)
  }

  private render(): void {
    const gl = this.gl
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w === 0 || h === 0) return

    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, Math.round(w * dpr))
    const ch = Math.max(1, Math.round(h * dpr))
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw
      this.canvas.height = ch
    }
    gl.viewport(0, 0, cw, ch)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    if (!this.geom || this.indexCount === 0) return

    if (this.autoRotate && !this.dragging) {
      this.theta += 0.006
    }

    const proj = this.perspective(45 * Math.PI / 180, w / Math.max(h, 1), 0.1, this.radius * 100)

    // model-view matrix (look-at)
    const eye = this.eyePosition()
    const center = this.target
    const up = [0, 0, 1]
    const f = normalize([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]])
    const s = normalize(cross(f, up))
    const u = cross(s, f)
    const modelView = [
      s[0], u[0], -f[0], 0,
      s[1], u[1], -f[1], 0,
      s[2], u[2], -f[2], 0,
      -(s[0] * eye[0] + s[1] * eye[1] + s[2] * eye[2]),
      -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
      (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]),
      1
    ]
    const normalMatrix = this.normalMatrixOf(modelView)

    gl.uniformMatrix4fv(this.uModelView, false, modelView)
    gl.uniformMatrix4fv(this.uProjection, false, proj)
    gl.uniformMatrix3fv(this.uNormalMatrix, false, normalMatrix)
    gl.uniform3f(this.uLightDir, -0.4, -0.5, 1.0)
    gl.uniform3f(this.uColor, this.color[0], this.color[1], this.color[2])
    gl.uniform1f(this.uLight, 1)

    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0)

    if (this.onFrame) this.onFrame()
  }

  private eyePosition(): [number, number, number] {
    const cx = this.target[0]
    const cy = this.target[1]
    const cz = this.target[2]
    const x = cx + this.distance * Math.sin(this.phi) * Math.cos(this.theta)
    const y = cy + this.distance * Math.sin(this.phi) * Math.sin(this.theta)
    const z = cz + this.distance * Math.cos(this.phi)
    return [x, y, z]
  }

  private perspective(fov: number, aspect: number, near: number, far: number): number[] {
    const f = 1 / Math.tan(fov / 2)
    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0
    ]
  }

  private normalMatrixOf(mv: number[]): number[] {
    // upper-left 3x3 transpose-inverse; with no scaling beyond uniform dist it is
    // close to the 3x3, but compute properly for correctness.
    const m00 = mv[0], m01 = mv[4], m02 = mv[8]
    const m10 = mv[1], m11 = mv[5], m12 = mv[9]
    const m20 = mv[2], m21 = mv[6], m22 = mv[10]
    const det = m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20)
    if (Math.abs(det) < 1e-12) return [m00, m01, m02, m10, m11, m12, m20, m21, m22]
    const inv = 1 / det
    // inverse
    const i00 = (m11 * m22 - m12 * m21) * inv
    const i01 = (m02 * m21 - m01 * m22) * inv
    const i02 = (m01 * m12 - m02 * m11) * inv
    const i10 = (m12 * m20 - m10 * m22) * inv
    const i11 = (m00 * m22 - m02 * m20) * inv
    const i12 = (m02 * m10 - m00 * m12) * inv
    const i20 = (m10 * m21 - m11 * m20) * inv
    const i21 = (m01 * m20 - m00 * m21) * inv
    const i22 = (m00 * m11 - m01 * m10) * inv
    // transpose
    return [i00, i01, i02, i10, i11, i12, i20, i21, i22]
  }

  private onPointerDown = (e: PointerEvent) => {
    this.dragging = true
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.canvas.setPointerCapture?.(e.pointerId)
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.theta -= dx * 0.008
    this.phi -= dy * 0.008
    this.phi = Math.max(0.15, Math.min(Math.PI - 0.15, this.phi))
  }

  private onPointerUp = () => {
    this.dragging = false
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1.1 : 0.9
    this.distance = Math.max(this.radius * 1.1, Math.min(this.radius * 20, this.distance * factor))
  }

  private buildProgram(gl: WebGLRenderingContext): WebGLProgram {
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh))
      }
      return sh
    }
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC)
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link error: ' + gl.getProgramInfoLog(prog))
    }
    return prog
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    const gl = this.gl
    gl.deleteBuffer(this.positionBuf)
    gl.deleteBuffer(this.normalBuf)
    gl.deleteBuffer(this.indexBuf)
    gl.deleteProgram(this.program)
  }
}

function normalize(v: number[]): number[] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]
}