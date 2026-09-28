/**
 * The observatory engine. Owns the WebGL2 context and drives, per frame:
 *   N sim substeps (leapfrog wave equation, P+S packed in one RGBA target)
 *   → energy accumulation → station probe (async PBO readback)
 *   → composite to screen (static engraved plate × living wavefield).
 *
 * Also schedules ambient seismicity in *simulation* time, so time dilation
 * slows the planet itself, not just the pixels.
 */

import { KM_PER_TEXEL, type Terrane } from './geology'
import { createFBO, createQuad, createTex, Prog } from './gl'
import { FRAG_COMPOSITE, FRAG_ENERGY, FRAG_PLATE, FRAG_PROBE, FRAG_SIM, VERT } from './shaders'
import { clamp, mulberry32, type Rng } from './prng'

export type Lens = 0 | 1 | 2 | 3
export type QuakeKind = 'RUPTURE' | 'AMBIENT' | 'SWARM' | 'MAINSHOCK' | 'AFTERSHOCK' | 'TEST SHOT'

export interface SeismicEvent {
  id: number
  x: number // texels
  y: number
  mag: number
  depthKm: number
  kind: QuakeKind
  simT: number
  wallMs: number
  angle: number
}

export interface FrameOut {
  /** [p0, s0, p1, s1, ...] displacement at each probe */
  samples: Float32Array
  simDt: number
  simTime: number
  fired: SeismicEvent[]
}

const DT = 0.0085 // sim seconds per substep — CFL-safe for vp ≤ 8.4 km/s
const SIM_RATE = 5.0 // sim seconds per wall second at ×1
const MAX_SUBSTEPS = 48
const MAX_SRC = 8
const N_PROBE = 8

interface Source {
  x: number
  y: number
  amp: number
  sigma: number
  t0: number
  freq: number
  angle: number
}

interface Pending {
  t: number
  x: number
  y: number
  mag: number
  kind: QuakeKind
}

export class Engine {
  readonly gl: WebGL2RenderingContext
  readonly simW: number
  readonly simH: number
  terrane: Terrane | null = null

  timeScale = 1
  lens: Lens = 0
  ambient = true

  private canvas: HTMLCanvasElement
  private quad: WebGLVertexArrayObject
  private pSim: Prog
  private pEnergy: Prog
  private pProbe: Prog
  private pPlate: Prog
  private pComposite: Prog

  private field: [WebGLTexture, WebGLTexture]
  private fieldFBO: [WebGLFramebuffer, WebGLFramebuffer]
  private fieldCur = 0
  private energy: [WebGLTexture, WebGLTexture]
  private energyFBO: [WebGLFramebuffer, WebGLFramebuffer]
  private energyCur = 0
  private velTex: WebGLTexture | null = null
  private styleTex: WebGLTexture | null = null
  private plateTex: WebGLTexture | null = null
  private plateFBO: WebGLFramebuffer | null = null
  private probeTex: WebGLTexture
  private probeFBO: WebGLFramebuffer
  private pbos: WebGLBuffer[] = []
  private syncs: (WebGLSync | null)[] = [null, null, null, null]
  private pboWrite = 0
  private probeBytes = new Uint8Array(N_PROBE * 4)

  private viewW = 2
  private viewH = 2
  private staticVariant = -1

  simTime = 0
  private substepCarry = 0
  private sources: Source[] = []
  private pending: Pending[] = []
  private eventCounter = 0
  private nextAmbientT = 2
  private nextMainT = 60
  private ambRng: Rng = mulberry32(1)
  private probePos = new Float32Array(N_PROBE * 2)
  private samples = new Float32Array(N_PROBE * 2)
  private srcA = new Float32Array(MAX_SRC * 4)
  private srcB = new Float32Array(MAX_SRC * 4)
  private flash = { x: 0, y: 0, wallMs: -1e9, mag: 0 }
  private fieldInternal: number
  private fieldType: number

  constructor(canvas: HTMLCanvasElement, simW: number, simH: number) {
    this.canvas = canvas
    this.simW = simW
    this.simH = simH
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('WebGL2 unavailable')
    this.gl = gl

    if (gl.getExtension('EXT_color_buffer_float')) {
      this.fieldInternal = gl.RGBA32F
      this.fieldType = gl.FLOAT
    } else if (gl.getExtension('EXT_color_buffer_half_float')) {
      this.fieldInternal = gl.RGBA16F
      this.fieldType = gl.HALF_FLOAT
    } else {
      throw new Error('float render targets unavailable')
    }

    this.quad = createQuad(gl)
    this.pSim = new Prog(gl, VERT, FRAG_SIM, 'sim')
    this.pEnergy = new Prog(gl, VERT, FRAG_ENERGY, 'energy')
    this.pProbe = new Prog(gl, VERT, FRAG_PROBE, 'probe')
    this.pPlate = new Prog(gl, VERT, FRAG_PLATE, 'plate')
    this.pComposite = new Prog(gl, VERT, FRAG_COMPOSITE, 'composite')

    const fieldOpts = { internal: this.fieldInternal, format: gl.RGBA, type: this.fieldType, filter: gl.NEAREST }
    const mk = () => {
      const t = createTex(gl, simW, simH, fieldOpts)
      return [t, createFBO(gl, t)] as const
    }
    const [fa, ffa] = mk()
    const [fb, ffb] = mk()
    const [ea, efa] = mk()
    const [eb, efb] = mk()
    this.field = [fa, fb]
    this.fieldFBO = [ffa, ffb]
    this.energy = [ea, eb]
    this.energyFBO = [efa, efb]

    this.probeTex = createTex(gl, N_PROBE, 1, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST })
    this.probeFBO = createFBO(gl, this.probeTex)
    for (let i = 0; i < 4; i++) {
      const p = gl.createBuffer()
      if (!p) throw new Error('PBO alloc failed')
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, N_PROBE * 4, gl.DYNAMIC_READ)
      this.pbos.push(p)
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
  }

  dispose(): void {
    const ext = this.gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  }

  // ---------------------------------------------------------------- terrane

  setTerrane(t: Terrane): void {
    const gl = this.gl
    this.terrane = t
    if (this.velTex) gl.deleteTexture(this.velTex)
    if (this.styleTex) gl.deleteTexture(this.styleTex)
    this.velTex = createTex(gl, t.W, t.H, { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST }, t.vel)
    this.styleTex = createTex(gl, t.W, t.H, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST }, t.style)
    this.sources = []
    this.pending = []
    this.simTime = 0
    this.substepCarry = 0
    this.ambRng = mulberry32(t.seed ^ 0x9e3779b9)
    this.nextAmbientT = 1.5 + this.ambRng() * 3
    this.nextMainT = 55 + this.ambRng() * 60
    this.clearFields()
    this.staticVariant = -1
    this.renderPlateIfNeeded()
  }

  groundYAt(xTexel: number): number {
    const t = this.terrane
    if (!t) return 0
    const x = clamp(Math.round(xTexel), 0, t.W - 1)
    return t.groundY[x]
  }

  setStations(xs: number[]): void {
    for (let i = 0; i < N_PROBE; i++) {
      const x = xs[Math.min(i, xs.length - 1)] ?? 0
      this.probePos[i * 2] = clamp(Math.round(x), 1, this.simW - 2)
      this.probePos[i * 2 + 1] = clamp(Math.ceil(this.groundYAt(x)) + 2, 1, this.simH - 2)
    }
  }

  clearFields(): void {
    const gl = this.gl
    gl.clearColor(0, 0, 0, 0)
    for (const f of [...this.fieldFBO, ...this.energyFBO]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    // drop in-flight probe readbacks (they hold pre-clear data) and zero the
    // published samples so the recorders never see the clear as ground motion
    for (let i = 0; i < this.syncs.length; i++) {
      const s = this.syncs[i]
      if (s) gl.deleteSync(s)
      this.syncs[i] = null
    }
    this.samples.fill(0)
  }

  // ---------------------------------------------------------------- control

  setLens(l: Lens): void {
    this.lens = l
    this.renderPlateIfNeeded()
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const gl = this.gl
    this.viewW = Math.max(2, Math.round(cssW * dpr))
    this.viewH = Math.max(2, Math.round(cssH * dpr))
    this.canvas.width = this.viewW
    this.canvas.height = this.viewH
    if (this.plateTex) gl.deleteTexture(this.plateTex)
    if (this.plateFBO) gl.deleteFramebuffer(this.plateFBO)
    this.plateTex = createTex(gl, this.viewW, this.viewH, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR })
    this.plateFBO = createFBO(gl, this.plateTex)
    this.staticVariant = -1
    this.renderPlateIfNeeded()
  }

  private renderPlateIfNeeded(): void {
    const gl = this.gl
    if (!this.terrane || !this.plateFBO || !this.velTex || !this.styleTex) return
    const variant = this.lens === 3 ? 2 : this.lens === 2 ? 1 : 0
    if (variant === this.staticVariant) return
    this.staticVariant = variant
    this.pPlate.use()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.plateFBO)
    gl.viewport(0, 0, this.viewW, this.viewH)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.styleTex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.velTex)
    gl.uniform1i(this.pPlate.u('uStyle'), 0)
    gl.uniform1i(this.pPlate.u('uVel'), 1)
    gl.uniform2f(this.pPlate.u('uRes'), this.viewW, this.viewH)
    gl.uniform1f(this.pPlate.u('uVariant'), variant)
    gl.uniform1f(this.pPlate.u('uSeed'), (this.terrane.seed % 97) * 0.37)
    this.draw()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  // ---------------------------------------------------------------- quakes

  fireQuake(x: number, y: number, mag: number, kind: QuakeKind, angleIn?: number): SeismicEvent {
    const t = this.terrane
    const gx = clamp(x, 16, this.simW - 16)
    const minY = (t ? this.groundYAt(gx) : 40) + 3
    const gy = clamp(y, minY, this.simH - 24)
    const m = clamp(mag, 1.5, 8)
    const angle = angleIn ?? this.ambRng() * Math.PI
    const src: Source = {
      x: gx,
      y: gy,
      amp: 0.9 * Math.pow(10, 0.44 * (m - 5)),
      sigma: 1.6 + (m - 3) * 0.42,
      t0: this.simTime,
      freq: 1 / (0.27 * Math.pow(10, 0.11 * (m - 5))),
      angle,
    }
    this.sources.push(src)
    if (this.sources.length > MAX_SRC) this.sources.splice(0, this.sources.length - MAX_SRC)
    const ev: SeismicEvent = {
      id: ++this.eventCounter,
      x: gx,
      y: gy,
      mag: m,
      depthKm: Math.max(0, (gy - this.groundYAt(gx)) * KM_PER_TEXEL),
      kind,
      simT: this.simTime,
      wallMs: performance.now(),
      angle,
    }
    if (m >= 4.4) this.flash = { x: gx, y: gy, wallMs: ev.wallMs, mag: clamp((m - 3) / 4, 0, 1) }
    return ev
  }

  swarmAt(x: number, y: number): void {
    const n = 6 + Math.floor(this.ambRng() * 5)
    let t = this.simTime + 0.05
    for (let i = 0; i < n; i++) {
      this.pending.push({
        t,
        x: x + (this.ambRng() - 0.5) * 14,
        y: y + (this.ambRng() - 0.5) * 12,
        mag: 2.7 + this.ambRng() * 1.7,
        kind: 'SWARM',
      })
      t += 0.12 + this.ambRng() * 0.55
    }
  }

  /** A weighted seismogenic site — ambient events & the opening shot use these. */
  pickSite(centerBias = false): { x: number; y: number } {
    const t = this.terrane
    if (!t || t.quakeSites.length === 0) return { x: this.simW / 2, y: this.simH / 2 }
    const sites = centerBias ? t.quakeSites.filter((s) => s.x > t.W * 0.22 && s.x < t.W * 0.78 && s.y < t.H * 0.72) : t.quakeSites
    const pool = sites.length ? sites : t.quakeSites
    let total = 0
    for (const s of pool) total += s.w
    let r = this.ambRng() * total
    for (const s of pool) {
      r -= s.w
      if (r <= 0) return { x: s.x + (this.ambRng() - 0.5) * 8, y: s.y + (this.ambRng() - 0.5) * 8 }
    }
    return { x: pool[0].x, y: pool[0].y }
  }

  private scheduleAmbient(fired: SeismicEvent[]): void {
    if (!this.ambient || !this.terrane) return
    if (this.simTime >= this.nextAmbientT) {
      const site = this.pickSite()
      const mag = 2.1 + Math.min(2.6, -Math.log(Math.max(1e-4, this.ambRng())) * 0.55)
      fired.push(this.fireQuake(site.x, site.y, mag, 'AMBIENT'))
      this.nextAmbientT = this.simTime + Math.max(1.2, -Math.log(Math.max(1e-4, this.ambRng())) * 7)
    }
    if (this.simTime >= this.nextMainT) {
      const site = this.pickSite(true)
      const mag = 5.4 + this.ambRng() * 1.2
      fired.push(this.fireQuake(site.x, site.y, mag, 'MAINSHOCK'))
      let t = this.simTime + 1.5
      const n = 5 + Math.floor(this.ambRng() * 4)
      for (let i = 0; i < n; i++) {
        t += (0.8 + this.ambRng() * 2.2) * (1 + i * 0.55) // Omori-flavored: gaps stretch
        this.pending.push({
          t,
          x: site.x + (this.ambRng() - 0.5) * 22,
          y: site.y + (this.ambRng() - 0.5) * 16,
          mag: mag - 1.1 - this.ambRng() * 1.4,
          kind: 'AFTERSHOCK',
        })
      }
      this.nextMainT = this.simTime + 75 + this.ambRng() * 70
    }
  }

  // ---------------------------------------------------------------- frame

  frame(dtWallMs: number, wallNowMs: number): FrameOut | null {
    const gl = this.gl
    const t = this.terrane
    if (!t || !this.velTex || !this.plateTex) return null

    const fired: SeismicEvent[] = []
    this.scheduleAmbient(fired)
    // due pending events
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].t <= this.simTime) {
        const p = this.pending[i]
        this.pending.splice(i, 1)
        fired.push(this.fireQuake(p.x, p.y, p.mag, p.kind))
      }
    }

    const dt = Math.min(dtWallMs, 55) / 1000
    this.substepCarry += dt * SIM_RATE * this.timeScale
    let n = Math.floor(this.substepCarry / DT)
    if (n > MAX_SUBSTEPS) {
      n = MAX_SUBSTEPS
      this.substepCarry = 0
    } else {
      this.substepCarry -= n * DT
    }

    // prune dead sources, upload the live ones
    this.sources = this.sources.filter((s) => this.simTime < s.t0 + 2.6 / s.freq)
    const ns = Math.min(this.sources.length, MAX_SRC)
    for (let i = 0; i < ns; i++) {
      const s = this.sources[i]
      this.srcA[i * 4] = s.x
      this.srcA[i * 4 + 1] = s.y
      this.srcA[i * 4 + 2] = s.amp
      this.srcA[i * 4 + 3] = s.sigma
      this.srcB[i * 4] = s.t0
      this.srcB[i * 4 + 1] = s.freq
      this.srcB[i * 4 + 2] = s.angle
      this.srcB[i * 4 + 3] = 0
    }

    gl.bindVertexArray(this.quad)

    if (n > 0) {
      this.pSim.use()
      gl.viewport(0, 0, this.simW, this.simH)
      gl.uniform1i(this.pSim.u('uVel'), 1)
      gl.uniform1i(this.pSim.u('uField'), 0)
      gl.uniform1f(this.pSim.u('uDtDx'), DT / KM_PER_TEXEL)
      gl.uniform1i(this.pSim.u('uNumSrc'), ns)
      gl.uniform4fv(this.pSim.u('uSrcA'), this.srcA)
      gl.uniform4fv(this.pSim.u('uSrcB'), this.srcB)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.velTex)
      for (let i = 0; i < n; i++) {
        const cur = this.fieldCur
        const nxt = 1 - cur
        gl.uniform1f(this.pSim.u('uSimTime'), this.simTime)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.field[cur])
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFBO[nxt])
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        this.fieldCur = nxt
        this.simTime += DT
      }

      // energy accumulation (once per frame)
      const eCur = this.energyCur
      const eNxt = 1 - eCur
      this.pEnergy.use()
      gl.uniform1i(this.pEnergy.u('uField'), 0)
      gl.uniform1i(this.pEnergy.u('uPrev'), 1)
      gl.uniform1f(this.pEnergy.u('uDecay'), Math.pow(0.9962, dt * 60 * Math.max(0.2, this.timeScale)))
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.field[this.fieldCur])
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.energy[eCur])
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.energyFBO[eNxt])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      this.energyCur = eNxt
    }

    // probe + async readback
    this.pProbe.use()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFBO)
    gl.viewport(0, 0, N_PROBE, 1)
    gl.uniform1i(this.pProbe.u('uField'), 0)
    gl.uniform2fv(this.pProbe.u('uProbe'), this.probePos)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.field[this.fieldCur])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    // 4-slot PBO ring; never rewrite a slot whose readback is still in flight
    const w = this.pboWrite
    if (this.syncs[w] === null) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[w])
      gl.readPixels(0, 0, N_PROBE, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      this.syncs[w] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      gl.flush() // fences may never signal without an explicit flush
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      this.pboWrite = (w + 1) % this.pbos.length
    }
    // drain the oldest ready slot (ring order: oldest pending sits at pboWrite)
    for (let k = 0; k < this.pbos.length; k++) {
      const idx = (this.pboWrite + k) % this.pbos.length
      const sync = this.syncs[idx]
      if (sync && gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) {
        gl.deleteSync(sync)
        this.syncs[idx] = null
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[idx])
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.probeBytes)
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
        for (let i = 0; i < N_PROBE; i++) {
          const hiP = this.probeBytes[i * 4]
          const loP = this.probeBytes[i * 4 + 1]
          const hiS = this.probeBytes[i * 4 + 2]
          const loS = this.probeBytes[i * 4 + 3]
          this.samples[i * 2] = ((hiP * 256 + loP) / 65535 - 0.5) * 16
          this.samples[i * 2 + 1] = ((hiS * 256 + loS) / 65535 - 0.5) * 16
        }
        break
      }
    }

    // composite
    const flashAge = (wallNowMs - this.flash.wallMs) / 750
    this.pComposite.use()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.viewW, this.viewH)
    gl.uniform1i(this.pComposite.u('uPlate'), 0)
    gl.uniform1i(this.pComposite.u('uField'), 1)
    gl.uniform1i(this.pComposite.u('uEnergy'), 2)
    gl.uniform2f(this.pComposite.u('uSimSize'), this.simW, this.simH)
    gl.uniform2f(this.pComposite.u('uRes'), this.viewW, this.viewH)
    gl.uniform1f(this.pComposite.u('uLens'), this.lens)
    gl.uniform1f(this.pComposite.u('uTime'), wallNowMs / 1000)
    gl.uniform4f(this.pComposite.u('uFlash'), this.flash.x, this.flash.y, flashAge > 1 ? 2 : Math.max(0.001, flashAge), this.flash.mag)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.plateTex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.field[this.fieldCur])
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.energy[this.energyCur])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)

    return { samples: this.samples, simDt: n * DT, simTime: this.simTime, fired }
  }

  private draw(): void {
    const gl = this.gl
    gl.bindVertexArray(this.quad)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }
}
