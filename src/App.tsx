import { useEffect, useRef, useState } from 'react'
import { Engine, type Lens, type QuakeKind, type SeismicEvent } from './engine/engine'
import { generateTerrane, KM_PER_TEXEL, type Terrane } from './engine/geology'
import { Recorders, type StationReadout } from './engine/seismo'
import { ObservatoryAudio } from './engine/audio'
import { chargeMag, drawOverlay, type OverlayState } from './engine/overlay'
import { clamp, randomSeed } from './engine/prng'
import { Shelf, type LogRow } from './ui/Shelf'

const KIND_LABEL: Record<QuakeKind, string> = {
  RUPTURE: 'INDUCED',
  AMBIENT: 'AMBIENT',
  SWARM: 'SWARM',
  MAINSHOCK: 'MAINSHOCK',
  AFTERSHOCK: 'AFTERSHOCK',
  'TEST SHOT': 'TEST SHOT',
}

const STATION_LABELS = ['A', 'B', 'C']

interface Sys {
  engine: Engine
  recorders: Recorders
  audio: ObservatoryAudio
  terrane: Terrane
  stationXs: number[]
  overlayCtx: CanvasRenderingContext2D
  cssW: number
  cssH: number
  hover: { x: number; y: number } | null
  charge: { x: number; y: number; t0: number; angle: number } | null
  dragging: number | null
  shake: number
  overlayEvents: SeismicEvent[]
  firstRupture: boolean
  plateNo: number
  raf: number
  lastT: number
  uiSyncT: number
}

interface TerraneMeta {
  title: string
  note: string
  seed: number
}

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null)
  const stageInnerRef = useRef<HTMLDivElement>(null)
  const glRef = useRef<HTMLCanvasElement>(null)
  const ovRef = useRef<HTMLCanvasElement>(null)
  const recCanvasRef = useRef<HTMLCanvasElement>(null)
  const sysRef = useRef<Sys | null>(null)

  const [glError, setGlError] = useState<string | null>(null)
  const [lens, setLensState] = useState<Lens>(0)
  const [timeScale, setTimeScaleState] = useState(1)
  const [ambient, setAmbientState] = useState(true)
  const [audioOn, setAudioOn] = useState(false)
  const [meta, setMeta] = useState<TerraneMeta>({ title: '', note: '', seed: 0 })
  const [events, setEvents] = useState<LogRow[]>([])
  const [stations, setStations] = useState<StationReadout[]>([])
  const [simClock, setSimClock] = useState(0)
  const [replate, setReplate] = useState(false)

  // stable action fns (defined via refs so listeners never go stale)
  const actions = useRef({
    setLens: (l: Lens) => {
      const s = sysRef.current
      if (!s) return
      s.engine.setLens(l)
      s.audio.click()
      setLensState(l)
    },
    setTimeScale: (t: number) => {
      const s = sysRef.current
      if (!s) return
      const v = clamp(t, 0.06, 2.5)
      s.engine.timeScale = v
      setTimeScaleState(v)
    },
    toggleAmbient: () => {
      const s = sysRef.current
      if (!s) return
      s.engine.ambient = !s.engine.ambient
      s.audio.click()
      setAmbientState(s.engine.ambient)
    },
    toggleAudio: () => {
      const s = sysRef.current
      if (!s) return
      if (s.audio.enabled) {
        void s.audio.disable()
        setAudioOn(false)
      } else {
        void s.audio.enable().then(() => s.audio.click())
        setAudioOn(true)
      }
    },
    reset: () => {
      const s = sysRef.current
      if (!s) return
      s.engine.clearFields()
      s.recorders.suppressPicks('all', 1.2)
      s.audio.click()
    },
    testShot: () => {
      const s = sysRef.current
      if (!s) return
      const site = s.engine.pickSite(true)
      fireQuake(site.x, site.y, 5.7 + Math.random() * 0.9, 'TEST SHOT')
      s.firstRupture = true
    },
    regen: () => {
      const s = sysRef.current
      if (!s) return
      s.plateNo += 1
      s.audio.click()
      makeTerrane(s.plateNo, false)
    },
  })

  function registerEvent(ev: SeismicEvent): void {
    const s = sysRef.current
    if (!s) return
    s.recorders.markEvent(ev)
    s.overlayEvents.push(ev)
    if (s.overlayEvents.length > 24) s.overlayEvents.splice(0, s.overlayEvents.length - 24)
    const row: LogRow = {
      id: ev.id,
      time: new Date().toLocaleTimeString('en-GB', { hour12: false }),
      mag: ev.mag,
      depthKm: ev.depthKm,
      kind: KIND_LABEL[ev.kind],
    }
    setEvents((rows) => [row, ...rows].slice(0, 5))
  }

  function fireQuake(x: number, y: number, mag: number, kind: QuakeKind, angle?: number): void {
    const s = sysRef.current
    if (!s) return
    registerEvent(s.engine.fireQuake(x, y, mag, kind, angle))
  }

  function makeTerrane(plateNo: number, avoidQuiet: boolean): void {
    const s = sysRef.current
    if (!s) return
    let t = s.terrane
    for (let tries = 0; tries < 5; tries++) {
      t = generateTerrane(randomSeed(), s.engine.simW, s.engine.simH, plateNo)
      if (!avoidQuiet || t.archetype !== 'CRATON') break
    }
    s.terrane = t
    s.engine.setTerrane(t)
    s.stationXs = [...t.stations]
    s.engine.setStations(s.stationXs)
    s.recorders.terraneChanged(s.stationXs, t.avgVp, t.avgVs)
    s.overlayEvents = []
    setMeta({ title: t.title, note: t.note, seed: t.seed })
    setEvents([])
    setReplate(true)
    window.setTimeout(() => setReplate(false), 520)
  }

  useEffect(() => {
    const stage = stageRef.current
    const stageInner = stageInnerRef.current
    const glc = glRef.current
    const ovc = ovRef.current
    const recc = recCanvasRef.current
    if (!stage || !stageInner || !glc || !ovc || !recc) return

    const rect = stage.getBoundingClientRect()
    const aspect = rect.width / Math.max(1, rect.height)
    const simW = 1024
    const simH = clamp(Math.round(1024 / aspect / 16) * 16, 320, 544)

    let engine: Engine
    try {
      engine = new Engine(glc, simW, simH)
    } catch (err) {
      setGlError(err instanceof Error ? err.message : String(err))
      return
    }

    const overlayCtx = ovc.getContext('2d')
    if (!overlayCtx) {
      setGlError('2d context unavailable')
      return
    }

    const recorders = new Recorders(recc, KM_PER_TEXEL)
    const audio = new ObservatoryAudio()

    const sys: Sys = {
      engine,
      recorders,
      audio,
      terrane: null as unknown as Terrane,
      stationXs: [],
      overlayCtx,
      cssW: rect.width,
      cssH: rect.height,
      hover: null,
      charge: null,
      dragging: null,
      shake: 0,
      overlayEvents: [],
      firstRupture: false,
      plateNo: 1,
      raf: 0,
      lastT: performance.now(),
      uiSyncT: 0,
    }
    sysRef.current = sys

    recorders.onPick = (_i, phase, strength) => {
      sys.shake = Math.min(1, sys.shake + strength * 0.5)
      audio.thump(strength, phase === 'S')
    }

    makeTerrane(1, true)

    const resize = () => {
      const r = stage.getBoundingClientRect()
      sys.cssW = r.width
      sys.cssH = r.height
      const dpr = Math.min(window.devicePixelRatio || 1, 1.6)
      engine.resize(r.width, r.height, dpr)
      ovc.width = Math.round(r.width * dpr)
      ovc.height = Math.round(r.height * dpr)
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const host = recc.parentElement
      if (host) {
        const rb = host.getBoundingClientRect()
        recorders.resize(rb.width, rb.height, dpr)
      }
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(stage)

    // opening shot — the observatory demonstrates itself
    const demoTimer = window.setTimeout(() => {
      if (!sys.firstRupture) {
        const site = engine.pickSite(true)
        fireQuake(site.x, site.y, 6.1 + Math.random() * 0.4, 'TEST SHOT')
      }
    }, 1250)

    // ---- pointer wiring ----------------------------------------------------
    const toLocal = (e: PointerEvent | MouseEvent) => {
      const r = ovc.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top, r }
    }
    const toTexel = (px: number, py: number) => ({
      tx: (px / sys.cssW) * simW,
      ty: (py / sys.cssH) * simH,
    })

    const stationHit = (px: number, py: number): number | null => {
      for (let i = 0; i < sys.stationXs.length; i++) {
        const sx = (sys.stationXs[i] / simW) * sys.cssW
        const sy = (engine.groundYAt(sys.stationXs[i]) / simH) * sys.cssH
        const dx = px - sx
        const dy = py - (sy - 14)
        if (dx * dx + dy * dy < 20 * 20) return i
      }
      return null
    }

    const onPointerMove = (e: PointerEvent) => {
      const { x, y } = toLocal(e)
      const inside = x >= 0 && y >= 0 && x <= sys.cssW && y <= sys.cssH
      sys.hover = inside ? { x, y } : null
      if (sys.dragging != null) {
        const { tx } = toTexel(x, y)
        const nx = clamp(tx, 14, simW - 14)
        sys.stationXs[sys.dragging] = nx
        engine.setStations(sys.stationXs)
        recorders.setStationX(sys.dragging, nx)
        recorders.suppressPicks(sys.dragging, 0.9)
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const { x, y } = toLocal(e)
      if (x < 0 || y < 0 || x > sys.cssW || y > sys.cssH) return
      const hit = stationHit(x, y)
      if (hit != null) {
        sys.dragging = hit
        return
      }
      const { tx, ty } = toTexel(x, y)
      if (ty > engine.groundYAt(tx)) {
        sys.charge = { x: tx, y: ty, t0: performance.now(), angle: Math.random() * Math.PI }
      }
    }
    const onPointerUp = () => {
      if (sys.dragging != null) sys.dragging = null
      if (sys.charge) {
        const c = sys.charge
        sys.charge = null
        fireQuake(c.x, c.y, chargeMag(performance.now() - c.t0), 'RUPTURE', c.angle)
        sys.firstRupture = true
      }
    }
    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      const { x, y } = toLocal(e)
      const { tx, ty } = toTexel(x, y)
      if (ty > engine.groundYAt(tx)) {
        engine.swarmAt(tx, ty)
        sys.firstRupture = true
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      actions.current.setTimeScale(engine.timeScale * Math.exp(-e.deltaY * 0.0012))
    }
    const onLeave = () => {
      sys.hover = null
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
      const k = e.key.toLowerCase()
      if (k >= '1' && k <= '4') actions.current.setLens((Number(k) - 1) as Lens)
      else if (k === 'g') actions.current.regen()
      else if (k === 'r') actions.current.reset()
      else if (k === 'a') actions.current.toggleAmbient()
      else if (k === 's') actions.current.toggleAudio()
      else if (k === ' ') {
        e.preventDefault()
        actions.current.testShot()
      }
    }

    window.addEventListener('pointermove', onPointerMove)
    ovc.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    ovc.addEventListener('contextmenu', onContext)
    stage.addEventListener('wheel', onWheel, { passive: false })
    ovc.addEventListener('pointerleave', onLeave)
    window.addEventListener('keydown', onKey)

    // ---- main loop ---------------------------------------------------------
    const loop = (t: number) => {
      const dt = Math.min(80, t - sys.lastT)
      sys.lastT = t
      const out = engine.frame(dt, t)
      if (out) {
        for (const ev of out.fired) registerEvent(ev)
        recorders.frame(out)
        const act = recorders.getActivity()
        audio.frame(act.amp, act.shear)

        sys.shake *= Math.exp((-dt / 1000) * 2.6)
        const a = sys.shake * sys.shake
        stageInner.style.transform = a > 0.0005 ? `scale(1.016) translate(${Math.sin(t * 0.055) * a * 8}px, ${Math.cos(t * 0.041) * a * 6}px)` : ''

        if (t - sys.uiSyncT > 200) {
          sys.uiSyncT = t
          setStations(recorders.getReadouts().map((r) => ({ ...r })))
          setSimClock(out.simTime)
        }
      }
      const ovState: OverlayState = {
        cssW: sys.cssW,
        cssH: sys.cssH,
        simW,
        simH,
        groundY: sys.terrane.groundY,
        stations: sys.stationXs.map((x, i) => ({ x, label: STATION_LABELS[i] })),
        hover: sys.hover,
        charge: sys.charge,
        draggingStation: sys.dragging,
        events: sys.overlayEvents,
        firstRuptureDone: sys.firstRupture,
        dark: engine.lens === 3,
      }
      drawOverlay(overlayCtx, ovState, t)
      sys.raf = requestAnimationFrame(loop)
    }
    sys.raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(sys.raf)
      window.clearTimeout(demoTimer)
      ro.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      ovc.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      ovc.removeEventListener('contextmenu', onContext)
      stage.removeEventListener('wheel', onWheel)
      ovc.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('keydown', onKey)
      void audio.disable()
      engine.dispose()
      sysRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (glError) {
    return (
      <div className="fault-card">
        <h1>TERRANE</h1>
        <div className="fault-title">INSTRUMENT FAULT</div>
        <p>This observatory requires WebGL2 with float render targets.</p>
        <p className="fault-detail">{glError}</p>
      </div>
    )
  }

  return (
    <div className={`app lens-${lens}`}>
      <div className="stage" ref={stageRef}>
        <div className="stage-inner" ref={stageInnerRef}>
          <canvas ref={glRef} className="gl-canvas" />
          <canvas ref={ovRef} className="overlay-canvas" />
        </div>
        <div className="plate-frame" />
        <div className="titleblock">
          <h1>TERRANE</h1>
          <div className="subtitle">SYNTHETIC SEISMOLOGY OBSERVATORY</div>
          <div className="plate-title">{meta.title}</div>
          <div className="plate-note">{meta.note}</div>
        </div>
        <div className="hints">
          <div>CLICK EARTH — RUPTURE · HOLD — GREATER YIELD</div>
          <div>RIGHT-CLICK — SWARM · WHEEL — TIME DILATION</div>
          <div>DRAG STATIONS · 1–4 LENS · G NEW TERRANE</div>
        </div>
        <div className="legend">
          <i className="sw sw-p" />
          P-WAVE
          <i className="sw sw-s" />
          S-WAVE
          <i className="sw sw-e" />
          SHAKING
        </div>
        <div className="plate-caption">
          N° {String(meta.seed % 100000).padStart(5, '0')} · H = V · 1 TEXEL ≈ 140 M
        </div>
        <div className={'replate' + (replate ? ' on' : '')} />
      </div>
      <Shelf
        recorderCanvasRef={recCanvasRef}
        lens={lens}
        onLens={actions.current.setLens}
        timeScale={timeScale}
        onTimeScale={actions.current.setTimeScale}
        ambient={ambient}
        onAmbient={actions.current.toggleAmbient}
        audioOn={audioOn}
        onAudio={actions.current.toggleAudio}
        onRegen={actions.current.regen}
        onReset={actions.current.reset}
        onTestShot={actions.current.testShot}
        events={events}
        stations={stations}
        simClock={simClock}
      />
    </div>
  )
}
