/**
 * Stage annotations, drawn crisp in CSS pixels over the GL plate:
 * surveyor hairlines + reticle, charge rings, station glyphs, hypocenter
 * marks, the depth scale, and the one-time "click to rupture" cue.
 */

import type { SeismicEvent } from './engine'
import { KM_PER_TEXEL } from './geology'

export interface OverlayState {
  cssW: number
  cssH: number
  simW: number
  simH: number
  groundY: Float32Array
  stations: { x: number; label: string }[]
  hover: { x: number; y: number } | null // css px
  charge: { x: number; y: number; t0: number; angle: number } | null
  draggingStation: number | null
  events: SeismicEvent[]
  firstRuptureDone: boolean
  dark: boolean
}

export function chargeMag(heldMs: number): number {
  return 3.2 + Math.min(1, Math.max(0, heldMs - 110) / 1500) * 3.4
}

export function drawOverlay(ctx: CanvasRenderingContext2D, st: OverlayState, nowMs: number): void {
  const { cssW: W, cssH: H, simW, simH } = st
  ctx.clearRect(0, 0, W, H)
  const ink = st.dark ? 'rgba(226,212,172,' : 'rgba(30,24,15,'
  const red = st.dark ? 'rgba(255,138,96,' : 'rgba(125,42,28,'
  const sx = W / simW
  const sy = H / simH
  const toPxX = (tx: number) => tx * sx
  const toPxY = (ty: number) => ty * sy
  const groundAt = (tx: number) => st.groundY[Math.max(0, Math.min(simW - 1, Math.round(tx)))]

  ctx.save()
  ctx.font = '500 10px "IBM Plex Mono", monospace'

  // ---- depth scale (right edge, clear of the title block) ------------------
  {
    const meanG = st.groundY.length ? st.groundY[Math.floor(simW * 0.5)] : simH * 0.16
    const x = W - 30
    const halo = st.dark ? 'rgba(19,16,9,0.85)' : 'rgba(233,223,196,0.85)'
    ctx.strokeStyle = ink + '0.45)'
    ctx.fillStyle = ink + '0.6)'
    ctx.lineWidth = 1
    ctx.textAlign = 'right'
    for (let dKm = 0; ; dKm += 10) {
      const ty = meanG + dKm / KM_PER_TEXEL
      if (ty > simH - 10) break
      const y = toPxY(ty)
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x - (dKm % 20 === 0 ? 9 : 5), y)
      ctx.stroke()
      if (dKm % 20 === 0 && dKm > 0) {
        const label = dKm === 20 ? '20 KM' : String(dKm)
        ctx.lineWidth = 3
        ctx.strokeStyle = halo
        ctx.strokeText(label, x - 13, y + 3)
        ctx.lineWidth = 1
        ctx.strokeStyle = ink + '0.45)'
        ctx.fillText(label, x - 13, y + 3)
      }
    }
    ctx.beginPath()
    ctx.strokeStyle = ink + '0.3)'
    ctx.moveTo(x, toPxY(meanG))
    ctx.lineTo(x, toPxY(simH - 10))
    ctx.stroke()
  }

  // ---- hypocenter marks ---------------------------------------------------
  for (const ev of st.events) {
    const age = (nowMs - ev.wallMs) / 1000
    if (age > 24) continue
    const x = toPxX(ev.x)
    const y = toPxY(ev.y)
    const fade = age < 1 ? 1 : Math.max(0, 1 - (age - 1) / 23)
    const r = 3 + (ev.mag - 2) * 1.1
    ctx.strokeStyle = red + (0.85 * fade).toFixed(3) + ')'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    for (let k = 0; k < 4; k++) {
      const a = (Math.PI / 4) * (k * 2 + 1)
      ctx.moveTo(x + Math.cos(a) * r * 0.35, y + Math.sin(a) * r * 0.35)
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r)
    }
    ctx.stroke()
    if (ev.mag >= 4.4 && age < 7) {
      ctx.fillStyle = red + (0.9 * fade).toFixed(3) + ')'
      ctx.textAlign = 'left'
      ctx.fillText('M' + ev.mag.toFixed(1), x + r + 5, y + 3)
    }
  }

  // ---- station glyphs ------------------------------------------------------
  st.stations.forEach((s, i) => {
    const x = toPxX(s.x)
    const gy = toPxY(groundAt(s.x))
    const hot = st.draggingStation === i
    ctx.strokeStyle = ink + (hot ? '0.95)' : '0.8)')
    ctx.fillStyle = ink + (hot ? '0.95)' : '0.8)')
    ctx.lineWidth = 1.3
    // tripod
    ctx.beginPath()
    ctx.moveTo(x - 6, gy)
    ctx.lineTo(x, gy - 9)
    ctx.lineTo(x + 6, gy)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x, gy - 9)
    ctx.lineTo(x, gy - 15)
    ctx.stroke()
    // label medallion
    ctx.beginPath()
    ctx.arc(x, gy - 22, 7.5, 0, Math.PI * 2)
    ctx.fillStyle = st.dark ? 'rgba(20,16,10,0.85)' : 'rgba(233,223,196,0.92)'
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = ink + '0.95)'
    ctx.textAlign = 'center'
    ctx.font = '600 10px "IBM Plex Mono", monospace'
    ctx.fillText(s.label, x, gy - 18.5)
    ctx.font = '500 10px "IBM Plex Mono", monospace'
    if (hot) {
      ctx.strokeStyle = ink + '0.25)'
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.moveTo(x, gy)
      ctx.lineTo(x, H - 14)
      ctx.stroke()
      ctx.setLineDash([])
    }
  })

  // ---- hover reticle / charge ---------------------------------------------
  if (st.charge) {
    const x = toPxX(st.charge.x)
    const y = toPxY(st.charge.y)
    const held = nowMs - st.charge.t0
    const mag = chargeMag(held)
    const r = 10 + (mag - 3.2) * 16
    ctx.strokeStyle = red + '0.9)'
    ctx.lineWidth = 1.4
    ctx.setLineDash([5, 4])
    ctx.lineDashOffset = -nowMs / 40
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(x, y, 2.4, 0, Math.PI * 2)
    ctx.fillStyle = red + '0.95)'
    ctx.fill()
    // fault plane preview
    ctx.strokeStyle = ink + '0.6)'
    ctx.beginPath()
    ctx.moveTo(x - Math.cos(st.charge.angle) * (r - 4), y - Math.sin(st.charge.angle) * (r - 4))
    ctx.lineTo(x + Math.cos(st.charge.angle) * (r - 4), y + Math.sin(st.charge.angle) * (r - 4))
    ctx.stroke()
    ctx.fillStyle = red + '0.95)'
    ctx.textAlign = 'left'
    ctx.font = '600 12px "IBM Plex Mono", monospace'
    ctx.fillText('M ' + mag.toFixed(1), x + r + 9, y + 4)
    ctx.font = '500 8.5px "IBM Plex Mono", monospace'
    ctx.fillText('YIELD', x + r + 9, y + 15)
  } else if (st.hover) {
    const { x, y } = st.hover
    const tx = (x / W) * simW
    const ty = (y / H) * simH
    const gy = groundAt(tx)
    const below = ty > gy
    ctx.strokeStyle = ink + '0.22)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(W, y + 0.5)
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, H)
    ctx.stroke()
    ctx.strokeStyle = ink + (below ? '0.75)' : '0.4)')
    ctx.beginPath()
    ctx.arc(x, y, 7, 0, Math.PI * 2)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.font = '500 10px "IBM Plex Mono", monospace'
    if (below) {
      const dKm = (ty - gy) * KM_PER_TEXEL
      ctx.fillStyle = ink + '0.8)'
      ctx.fillText('D ' + dKm.toFixed(1) + ' KM', x + 13, y - 9)
      if (!st.firstRuptureDone) {
        ctx.fillStyle = red + '0.95)'
        ctx.font = '600 11px "IBM Plex Mono", monospace'
        ctx.fillText('CLICK TO RUPTURE · HOLD FOR YIELD', x + 13, y + 22)
      }
    } else {
      ctx.fillStyle = ink + '0.5)'
      ctx.fillText('SURFACE', x + 13, y - 9)
    }
  }

  ctx.restore()
}
