/** The instrument shelf: recorders, station analysis, event register, command cluster. */

import { useCallback, useRef, type RefObject } from 'react'
import type { Lens } from '../engine/engine'
import type { StationReadout } from '../engine/seismo'

export interface LogRow {
  id: number
  time: string
  mag: number
  depthKm: number
  kind: string
}

interface ShelfProps {
  recorderCanvasRef: RefObject<HTMLCanvasElement | null>
  lens: Lens
  onLens: (l: Lens) => void
  timeScale: number
  onTimeScale: (t: number) => void
  ambient: boolean
  onAmbient: () => void
  audioOn: boolean
  onAudio: () => void
  onRegen: () => void
  onReset: () => void
  onTestShot: () => void
  events: LogRow[]
  stations: StationReadout[]
  simClock: number
}

const LENSES: { key: string; label: string }[] = [
  { key: '1', label: 'SECTION' },
  { key: '2', label: 'ENERGY' },
  { key: '3', label: 'X-RAY' },
  { key: '4', label: 'DARK' },
]

const T_MIN = Math.log(0.06)
const T_MAX = Math.log(2.5)

function timeToPos(t: number): number {
  return (Math.log(t) - T_MIN) / (T_MAX - T_MIN)
}
function posToTime(p: number): number {
  return Math.exp(T_MIN + (T_MAX - T_MIN) * Math.min(1, Math.max(0, p)))
}

function TimeLever({ value, onChange }: { value: number; onChange: (t: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useCallback(
    (e: React.PointerEvent) => {
      const el = trackRef.current
      if (!el) return
      const move = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect()
        onChange(posToTime(1 - (ev.clientY - r.top) / r.height))
      }
      move(e.nativeEvent)
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [onChange],
  )
  const pos = timeToPos(value)
  return (
    <div className="lever-block">
      <div className="module-tag">TIME</div>
      <div className="lever-track" ref={trackRef} onPointerDown={drag}>
        {[0.1, 0.25, 0.5, 1, 2].map((d) => (
          <div key={d} className="lever-detent" style={{ bottom: `${timeToPos(d) * 100}%` }}>
            <span>{d < 1 ? `×${d}` : `×${d}.0`}</span>
          </div>
        ))}
        <div className="lever-handle" style={{ bottom: `calc(${pos * 100}% - 7px)` }} />
      </div>
      <div className="lever-readout">×{value.toFixed(2)}</div>
      <div className="key-hint">WHEEL</div>
    </div>
  )
}

export function Shelf(p: ShelfProps) {
  return (
    <div className="shelf">
      <section className="module module-recorders">
        <div className="module-label">
          DRUM RECORDERS <span className="module-sub">· INK ON PAPER · 30 PX / S</span>
        </div>
        <div className="recorder-host">
          <canvas ref={p.recorderCanvasRef} className="recorder-canvas" />
        </div>
      </section>

      <section className="module module-analysis">
        <div className="module-label">
          STATION ANALYSIS <span className="module-sub">· S–P METHOD</span>
        </div>
        <div className="station-rows">
          {p.stations.map((s) => (
            <div className="station-row" key={s.label}>
              <span className="st-label">{s.label}</span>
              <span className="st-pos">{s.posKm.toFixed(0)} KM</span>
              <span className="st-delta">{s.deltaKm != null ? `Δ ${s.deltaKm.toFixed(1)} KM` : 'Δ —'}</span>
              <span className="st-mag">{s.magEst != null ? `M≈${s.magEst.toFixed(1)}` : 'M≈ —'}</span>
              <span className="st-lamp" style={{ opacity: 0.15 + s.live * 0.85, boxShadow: `0 0 ${3 + s.live * 9}px rgba(213,96,56,${s.live * 0.9})` }} />
            </div>
          ))}
        </div>
        <div className="register-head">EVENT REGISTER</div>
        <div className="register">
          {p.events.length === 0 && <div className="register-row register-empty">— AWAITING FIRST EVENT —</div>}
          {p.events.map((e) => (
            <div className="register-row" key={e.id}>
              <span className="reg-id">N°{String(e.id).padStart(2, '0')}</span>
              <span className="reg-time">{e.time}</span>
              <span className="reg-mag">M{e.mag.toFixed(1)}</span>
              <span className="reg-depth">D{e.depthKm.toFixed(0)}</span>
              <span className="reg-kind">{e.kind}</span>
            </div>
          ))}
        </div>
        <div className="drum-clock">DRUM T+ {p.simClock.toFixed(1)} S</div>
      </section>

      <section className="module module-command">
        <div className="module-label">COMMAND</div>
        <div className="command-grid">
          <TimeLever value={p.timeScale} onChange={p.onTimeScale} />
          <div className="command-right">
            <div className="module-tag">LENS</div>
            <div className="lens-row">
              {LENSES.map((l, i) => (
                <button key={l.label} className={'panel-btn lens-btn' + (p.lens === i ? ' latched' : '')} onClick={() => p.onLens(i as Lens)}>
                  <span className="keycap">{l.key}</span>
                  {l.label}
                </button>
              ))}
            </div>
            <div className="module-tag">TERRANE</div>
            <div className="btn-row">
              <button className="panel-btn wide" onClick={p.onRegen}>
                <span className="keycap">G</span>STRIKE NEW TERRANE
              </button>
              <button className="panel-btn" onClick={p.onReset}>
                <span className="keycap">R</span>STILL
              </button>
              <button className="panel-btn" onClick={p.onTestShot}>
                <span className="keycap">␣</span>SHOT
              </button>
            </div>
            <div className="module-tag">SWITCHES</div>
            <div className="btn-row">
              <button className={'panel-btn toggle' + (p.ambient ? ' latched' : '')} onClick={p.onAmbient}>
                <span className={'lamp' + (p.ambient ? ' lit' : '')} />
                <span className="keycap">A</span>AMBIENT SEISMICITY
              </button>
              <button className={'panel-btn toggle' + (p.audioOn ? ' latched' : '')} onClick={p.onAudio}>
                <span className={'lamp' + (p.audioOn ? ' lit' : '')} />
                <span className="keycap">S</span>AUDIO
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
