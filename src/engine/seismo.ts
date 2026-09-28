/**
 * Drum recorders: three ink strip-charts driven by the station probes.
 *
 * The pens are physical — a slightly underdamped second-order arm chases the
 * ground velocity, so sharp arrivals overshoot and ring; ink pools wider when
 * the pen moves slowly. Paper scrolls in *simulation* time, so time dilation
 * slows the drums along with the planet. A two-channel onset picker measures
 * S–P intervals into epicentral distances, exactly like the wall chart says.
 */

import type { FrameOut, SeismicEvent } from './engine'
import { clamp } from './prng'

export interface StationReadout {
  label: string
  posKm: number
  deltaKm: number | null
  magEst: number | null
  live: number // 0..1 recent activity, drives the shelf lamps
}

interface PenState {
  y: number
  v: number
  prevP: number
  prevS: number
  prevAP: number
  prevAS: number
  picked: boolean
  tP: number
  tS: number
  peakV: number
  quietFor: number
  clipFlash: number
}

const PX_PER_SIMSEC = 30
const HDR = 58 // static header zone, css px
const PEN_K = 260
const PEN_C = 19

export class Recorders {
  onPick: ((station: number, phase: 'P' | 'S', strength: number) => void) | null = null
  onReadout: ((info: StationReadout[]) => void) | null = null

  private ctx: CanvasRenderingContext2D
  private cssW = 10
  private cssH = 10
  private dpr = 1
  private labels = ['A', 'B', 'C']
  private xs = [0, 0, 0]
  private pens: PenState[] = []
  private scrollCarry = 0
  private lastGridT = 0
  private avgVp = 5.5
  private avgVs = 3.2
  private kmPerTexel: number
  private noiseT = Math.random() * 100
  private scrolledPx = 0
  private lastLabelAt = -100
  private pendingStamps: { mag: number; kind: string }[] = []
  private readouts: StationReadout[] = []
  private suppress = [0, 0, 0] // sim-seconds of pick suppression (resets, drags)
  private suppressFrames = [0, 0, 0] // frame-counted suppression covering readback latency

  constructor(
    private canvas: HTMLCanvasElement,
    kmPerTexel: number,
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    this.kmPerTexel = kmPerTexel
    for (let i = 0; i < 3; i++) this.pens.push(this.freshPen())
  }

  private freshPen(): PenState {
    return { y: 0, v: 0, prevP: 0, prevS: 0, prevAP: 0, prevAS: 0, picked: false, tP: 0, tS: 0, peakV: 0, quietFor: 0, clipFlash: 0 }
  }

  /** Sub-frame arrival time: interpolate where |v| crossed the threshold within this frame. */
  private crossTime(simTime: number, simDt: number, prevA: number, a: number, thr: number): number {
    const denom = a - prevA
    const f = denom > 1e-9 ? Math.min(1, Math.max(0, (thr - prevA) / denom)) : 1
    return simTime - simDt * (1 - f)
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = cssW
    this.cssH = cssH
    this.dpr = dpr
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.freshPaper()
  }

  setStations(xs: number[], avgVp: number, avgVs: number): void {
    this.xs = xs.slice(0, 3)
    this.avgVp = avgVp
    this.avgVs = avgVs
    this.publishReadouts()
  }

  setStationX(i: number, x: number): void {
    this.xs[i] = x
    this.publishReadouts()
  }

  terraneChanged(xs: number[], avgVp: number, avgVs: number): void {
    this.setStations(xs, avgVp, avgVs)
    this.pens = this.pens.map(() => this.freshPen())
    this.lastGridT = 0
    this.scrollCarry = 0
    for (const r of this.readouts) {
      r.deltaKm = null
      r.magEst = null
    }
    this.freshPaper()
    this.publishReadouts()
  }

  markEvent(ev: SeismicEvent): void {
    this.pendingStamps.push({ mag: ev.mag, kind: ev.kind })
  }

  /** Field resets and station drags create step discontinuities — no picking through those. */
  suppressPicks(which: number | 'all', secs: number, frames = 5): void {
    for (let i = 0; i < 3; i++) {
      if (which === 'all' || which === i) {
        this.suppress[i] = Math.max(this.suppress[i], secs)
        this.suppressFrames[i] = Math.max(this.suppressFrames[i], frames)
        this.pens[i].picked = false
      }
    }
  }

  private stripTop(i: number): number {
    return (this.cssH / 3) * i
  }
  private stripH(): number {
    return this.cssH / 3
  }

  private freshPaper(): void {
    const c = this.ctx
    c.save()
    c.fillStyle = '#e7dcc0'
    c.fillRect(0, 0, this.cssW, this.cssH)
    // preprinted drum ruling, aligned so live rules continue the pattern
    // (t = 0 sits at the right edge; rules march left every second of drum time)
    for (let k = 0; ; k++) {
      const gx = this.cssW - k * PX_PER_SIMSEC
      if (gx < HDR) break
      const red = k % 10 === 0
      c.strokeStyle = red ? 'rgba(125,42,28,0.42)' : 'rgba(34,28,20,0.12)'
      c.lineWidth = red ? 1.2 : 1
      for (let i = 0; i < 3; i++) {
        const top = this.stripTop(i)
        c.beginPath()
        c.moveTo(Math.round(gx) + 0.5, top + 4)
        c.lineTo(Math.round(gx) + 0.5, top + this.stripH() - 4)
        c.stroke()
      }
    }
    for (let i = 0; i < 3; i++) this.paintHeader(i)
    for (let i = 0; i < 3; i++) {
      const top = this.stripTop(i)
      const h = this.stripH()
      c.strokeStyle = 'rgba(34,28,20,0.35)'
      c.lineWidth = 1
      c.strokeRect(HDR + 0.5, top + 2.5, this.cssW - HDR - 1, h - 5)
      c.strokeStyle = 'rgba(34,28,20,0.14)'
      c.beginPath()
      c.moveTo(HDR, top + h / 2)
      c.lineTo(this.cssW, top + h / 2)
      c.stroke()
    }
    c.restore()
  }

  private paintHeader(i: number): void {
    const c = this.ctx
    const top = this.stripTop(i)
    const h = this.stripH()
    c.save()
    c.fillStyle = '#ded2b2'
    c.fillRect(0, top + 2, HDR - 4, h - 4)
    c.strokeStyle = 'rgba(34,28,20,0.4)'
    c.lineWidth = 1
    c.strokeRect(0.5, top + 2.5, HDR - 4, h - 5)
    c.fillStyle = '#241d13'
    c.font = '700 17px "IBM Plex Mono", monospace'
    c.textAlign = 'center'
    c.fillText(this.labels[i], (HDR - 4) / 2, top + h / 2 + 1)
    c.font = '500 8px "IBM Plex Mono", monospace'
    c.fillStyle = 'rgba(34,26,16,0.72)'
    c.fillText('STA·' + this.labels[i], (HDR - 4) / 2, top + h / 2 + 12)
    const km = (this.xs[i] * this.kmPerTexel).toFixed(0)
    c.fillText(km + ' KM', (HDR - 4) / 2, top + 13)
    c.restore()
  }

  /** Advance the drums by one animation frame. */
  frame(out: FrameOut): void {
    const c = this.ctx
    const { samples, simDt, simTime } = out

    // --- scroll paper -----------------------------------------------------
    this.scrollCarry += simDt * PX_PER_SIMSEC
    const m = Math.floor(this.scrollCarry)
    this.scrollCarry -= m
    this.scrolledPx += m
    const w = this.cssW
    if (m > 0 && m < w - HDR) {
      const d = this.dpr
      c.save()
      c.setTransform(1, 0, 0, 1, 0, 0)
      c.drawImage(
        this.canvas,
        Math.round((HDR + m) * d), 0, Math.round((w - HDR - m) * d), this.canvas.height,
        Math.round(HDR * d), 0, Math.round((w - HDR - m) * d), this.canvas.height,
      )
      c.restore()
      // fresh paper column
      c.fillStyle = '#e7dcc0'
      c.fillRect(w - m, 0, m, this.cssH)
      // time grid: light second rules, red rules every 10 s
      while (this.lastGridT + 1 <= simTime) {
        this.lastGridT += 1
        const gx = w - (simTime - this.lastGridT) * PX_PER_SIMSEC
        if (gx >= w - m - 1 && gx < w) {
          const red = this.lastGridT % 10 === 0
          c.strokeStyle = red ? 'rgba(125,42,28,0.5)' : 'rgba(34,28,20,0.13)'
          c.lineWidth = red ? 1.2 : 1
          for (let i = 0; i < 3; i++) {
            const top = this.stripTop(i)
            c.beginPath()
            c.moveTo(Math.round(gx) + 0.5, top + 4)
            c.lineTo(Math.round(gx) + 0.5, top + this.stripH() - 4)
            c.stroke()
          }
        }
      }
      // strip frames (top/bottom rails redrawn in the fresh region)
      for (let i = 0; i < 3; i++) {
        const top = this.stripTop(i)
        const h = this.stripH()
        c.strokeStyle = 'rgba(34,28,20,0.35)'
        c.lineWidth = 1
        c.beginPath()
        c.moveTo(w - m, top + 2.5)
        c.lineTo(w, top + 2.5)
        c.moveTo(w - m, top + h - 2.5)
        c.lineTo(w, top + h - 2.5)
        c.stroke()
        c.strokeStyle = 'rgba(34,28,20,0.12)'
        c.beginPath()
        c.moveTo(w - m, top + h / 2)
        c.lineTo(w, top + h / 2)
        c.stroke()
      }
      // event stamps land on the fresh edge
      for (const st of this.pendingStamps) {
        for (let i = 0; i < 3; i++) {
          const top = this.stripTop(i)
          const h = this.stripH()
          c.strokeStyle = 'rgba(125,42,28,0.75)'
          c.lineWidth = 1
          c.setLineDash([2.5, 3])
          c.beginPath()
          c.moveTo(w - 1.5, top + 4)
          c.lineTo(w - 1.5, top + h - 4)
          c.stroke()
          c.setLineDash([])
          // label only when the paper has moved on from the previous label
          if (i === 0 && this.scrolledPx - this.lastLabelAt > 30) {
            this.lastLabelAt = this.scrolledPx
            c.fillStyle = 'rgba(125,42,28,0.9)'
            c.font = '500 8.5px "IBM Plex Mono", monospace'
            c.textAlign = 'right'
            c.fillText('M' + st.mag.toFixed(1), w - 3, top + 11)
          }
        }
      }
      this.pendingStamps.length = 0
    }

    // --- pens ---------------------------------------------------------------
    this.noiseT += simDt
    let frameAmp = 0
    let frameShear = 0
    for (let i = 0; i < 3; i++) {
      const pen = this.pens[i]
      const P = samples[i * 2]
      const S = samples[i * 2 + 1]
      let vP = 0
      let vS = 0
      if (simDt > 1e-6) {
        vP = (P - pen.prevP) / simDt
        vS = (S - pen.prevS) / simDt
        pen.prevP = P
        pen.prevS = S
      }
      const vC = vP + vS

      // picking
      const aP = Math.abs(vP)
      const aS = Math.abs(vS)
      const aC = Math.abs(vC)
      frameAmp = Math.max(frameAmp, aC)
      frameShear = Math.max(frameShear, aS)
      if (this.suppress[i] > 0 || this.suppressFrames[i] > 0) {
        this.suppress[i] -= simDt
        this.suppressFrames[i] -= 1
        pen.picked = false
      }
      if (this.suppress[i] <= 0 && this.suppressFrames[i] <= 0 && !pen.picked && aP > 0.02) {
        pen.picked = true
        pen.tP = this.crossTime(simTime, simDt, pen.prevAP, aP, 0.02)
        pen.tS = -1
        pen.peakV = 0
        pen.quietFor = 0
        this.onPick?.(i, 'P', Math.min(1, aP * 6))
      }
      if (pen.picked) {
        const aPeak = Math.max(aP, aS) // strongest single channel; vC would double-count
        if (aPeak > pen.peakV) {
          pen.peakV = aPeak
          // provisional magnitude, refined as the shaking grows — but only
          // once this station has an S–P distance to correct against
          const r = this.readouts[i]
          if (r && r.deltaKm != null) {
            const m = this.estimateMag(pen.peakV, r.deltaKm)
            if (r.magEst == null || Math.abs(m - r.magEst) > 0.1) {
              r.magEst = m
              this.publishReadouts()
            }
          }
        }
        if (pen.tS < 0 && simTime > pen.tP + 0.12 && aS > 0.018) {
          pen.tS = Math.max(pen.tP + 0.1, this.crossTime(simTime, simDt, pen.prevAS, aS, 0.018))
          const sp = pen.tS - pen.tP
          const delta = (sp * (this.avgVp * this.avgVs)) / (this.avgVp - this.avgVs)
          const r = this.readouts[i]
          if (r) {
            r.deltaKm = delta
            this.publishReadouts()
          }
          this.onPick?.(i, 'S', Math.min(1, aS * 5))
        }
        if (aC < 0.012) {
          pen.quietFor += simDt
          if (pen.quietFor > 2.2) {
            // finalize the magnitude estimate from peak velocity + distance
            const r = this.readouts[i]
            if (r && pen.peakV > 0 && r.deltaKm != null) {
              r.magEst = this.estimateMag(pen.peakV, r.deltaKm)
              this.publishReadouts()
            }
            pen.picked = false
          }
        } else {
          pen.quietFor = 0
        }
      }
      pen.prevAP = aP
      pen.prevAS = aS

      // pen dynamics — underdamped arm chasing tanh'd velocity
      const h = this.stripH()
      const rail = h * 0.36
      const micro = (Math.sin(this.noiseT * 5.1 + i * 9.3) * 0.5 + Math.sin(this.noiseT * 13.7 + i * 3.1) * 0.3) * 0.55
      const target = Math.tanh(vC * 0.85) * rail + micro
      let sub = Math.max(1, Math.ceil(simDt / 0.004))
      if (sub > 12) sub = 12
      const sdt = simDt / sub
      for (let k = 0; k < sub; k++) {
        const acc = PEN_K * (target - pen.y) - PEN_C * pen.v
        pen.v += acc * sdt
        pen.y += pen.v * sdt
      }
      const clipped = Math.abs(pen.y) > rail * 1.16
      pen.y = clamp(pen.y, -rail * 1.18, rail * 1.18)
      if (clipped) pen.clipFlash = 1
      else pen.clipFlash *= 0.92

      const r = this.readouts[i]
      if (r) r.live = Math.max(r.live * 0.94, Math.min(1, aC * 2.4))

      // ink segment for this frame
      if (m > 0) {
        const top = this.stripTop(i)
        const mid = top + h / 2
        const yNew = mid + pen.y
        const speed = Math.abs(pen.v)
        c.strokeStyle = clipped ? 'rgba(96,26,16,0.9)' : 'rgba(28,22,14,0.88)'
        c.lineWidth = clamp(1.45 - speed * 0.011, 0.5, 1.45)
        c.lineCap = 'round'
        c.beginPath()
        c.moveTo(w - m - 0.5, (this.lastPenPx[i] ?? yNew))
        c.lineTo(w - 0.5, yNew)
        c.stroke()
        this.lastPenPx[i] = yNew
        if (clipped && pen.clipFlash > 0.99) {
          c.fillStyle = 'rgba(125,42,28,0.85)'
          c.fillRect(w - 2.5, top + 4, 2.5, 3.5)
        }
      }
    }
    this.actAmp = Math.max(this.actAmp * 0.9, frameAmp)
    this.actShear = Math.max(this.actShear * 0.9, frameShear)
  }

  private lastPenPx: (number | null)[] = [null, null, null]
  private actAmp = 0
  private actShear = 0

  getActivity(): { amp: number; shear: number } {
    return { amp: this.actAmp, shear: this.actShear }
  }

  /**
   * Local-magnitude-flavored estimate from peak pen velocity and distance.
   * Constants invert the engine's source scaling: amp = 0.9·10^0.44(M−5),
   * f = (1/0.27)·10^−0.11(M−5), cylindrical spreading ∝ r^−1/2.
   */
  private estimateMag(peakV: number, distKm: number): number {
    const rTex = Math.max(6, distKm / this.kmPerTexel)
    const m = 5 + (Math.log10(peakV) - 1.7 + 0.5 * Math.log10(rTex) + rTex * 0.00085) / 0.36
    return clamp(m, 0.5, 8.8)
  }

  refreshHeaders(): void {
    for (let i = 0; i < 3; i++) this.paintHeader(i)
  }

  private publishReadouts(): void {
    if (this.readouts.length !== 3) {
      this.readouts = this.labels.map((label, i) => ({
        label,
        posKm: this.xs[i] * this.kmPerTexel,
        deltaKm: null,
        magEst: null,
        live: 0,
      }))
    }
    for (let i = 0; i < 3; i++) {
      this.readouts[i].posKm = this.xs[i] * this.kmPerTexel
    }
    this.onReadout?.(this.readouts)
    this.refreshHeaders()
  }

  getReadouts(): StationReadout[] {
    if (this.readouts.length !== 3) this.publishReadouts()
    return this.readouts
  }
}
