/**
 * Procedural terrane generation.
 *
 * A "terrane" is one synthetic geological cross-section: layered crust folded,
 * faulted, intruded and flooded according to one of five archetypes. It is
 * emitted as two textures —
 *   vel   (RGBA32F): vp km/s, vs km/s, attenuation/substep, material id
 *   style (RGBA8)  : tint index, hatch density, hatch angle code, edge mask
 * — plus metadata the instrument shelf and ambient-seismicity scheduler use.
 */

import { mulberry32, fbm1, fbm2, clamp, lerp, type Rng } from './prng'

export const KM_PER_TEXEL = 0.140625

// hatch angle byte codes ≥ 240 select special fills in the plate shader
export const HATCH_CROSS = 250 // mantle
export const HATCH_STIPPLE = 246 // melt
export const HATCH_WATER = 242 // water
export const HATCH_SLAB = 238 // subducting slab

export const MAT_AIR = 0
export const MAT_WATER = 1
export const MAT_ROCK = 2
export const MAT_MELT = 3
export const MAT_MANTLE = 4

export interface QuakeSite {
  x: number
  y: number
  w: number
}

export interface Terrane {
  seed: number
  archetype: string
  title: string
  note: string
  W: number
  H: number
  vel: Float32Array
  style: Uint8Array
  groundY: Float32Array // solid ground surface (seabed under water), texel y per x
  seaLevelY: number // -1 when dry
  hasWater: boolean
  hasMelt: boolean
  stations: number[] // default station x positions (texels)
  quakeSites: QuakeSite[]
  avgVp: number
  avgVs: number
}

interface Fault {
  fx: number // x where the fault meets the nominal ground line
  dip: number // radians from horizontal
  dir: 1 | -1 // dip direction
  slip: number // texels of throw
  sole: number // depth (texels) where slip tapers out
}

interface LayerSpec {
  bottom: number // nominal depth of layer bottom, texels below ground base
  vp: number
  vs: number
  att: number
  tint: number
  hatchAngle: number // byte code
  hatchDensity: number
}

const ARCHETYPES = ['CRATON', 'FORELAND', 'RIFT', 'ARC', 'BASIN'] as const
type Archetype = (typeof ARCHETYPES)[number]

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX']

export function roman(n: number): string {
  return ROMAN[(n - 1) % ROMAN.length]
}

/** Sediment/crust tints cycle through the plate's ink palette (indices into shader palette). */
const SEDIMENT_TINTS = [1, 2, 3, 4, 5, 6]

export function generateTerrane(seed: number, W: number, H: number, plateNo: number): Terrane {
  const rng = mulberry32(seed)
  const archetype = ARCHETYPES[Math.floor(rng() * ARCHETYPES.length)]
  return buildTerrane(seed, rng, archetype, W, H, plateNo)
}

function buildTerrane(seed: number, rng: Rng, archetype: Archetype, W: number, H: number, plateNo: number): Terrane {
  const groundBase = Math.round(H * 0.165) // nominal ground line, texels from top
  const noiseSeed = Math.floor(rng() * 1e9)

  // ---- archetype scaffolding ---------------------------------------------
  const foldAmp =
    archetype === 'FORELAND' ? lerp(10, 22, rng()) :
    archetype === 'CRATON' ? lerp(1, 3, rng()) :
    archetype === 'BASIN' ? lerp(2, 5, rng()) :
    lerp(4, 9, rng())
  const foldWavelength = lerp(180, 420, rng())
  const foldPhase = rng() * Math.PI * 2

  const fold = (x: number): number =>
    Math.sin((x / foldWavelength) * Math.PI * 2 + foldPhase) * foldAmp +
    fbm1(x * 0.004, noiseSeed + 11, 3) * foldAmp * 0.9

  // ocean (ARC always; RIFT sometimes gets a rift lake)
  const oceanSide: 1 | -1 = rng() < 0.5 ? 1 : -1 // 1 = ocean on the right
  const hasOcean = archetype === 'ARC'
  const riftLake = archetype === 'RIFT' && rng() < 0.55
  const oceanFrac = hasOcean ? lerp(0.3, 0.42, rng()) : 0
  const coastX = oceanSide === 1 ? W * (1 - oceanFrac) : W * oceanFrac
  const riftCx = W * lerp(0.38, 0.62, rng())
  const riftHalf = lerp(60, 110, rng())

  const seaLevelY = hasOcean || riftLake ? groundBase + 6 : -1

  // Moho depth (texels below ground base)
  const mohoDepth =
    archetype === 'CRATON' ? lerp(300, 350, rng()) :
    archetype === 'RIFT' ? lerp(190, 230, rng()) :
    lerp(240, 300, rng())

  // ---- layer stack --------------------------------------------------------
  const nLayers =
    archetype === 'FORELAND' ? 7 + Math.floor(rng() * 3) :
    archetype === 'CRATON' ? 4 + Math.floor(rng() * 2) :
    5 + Math.floor(rng() * 3)

  const layers: LayerSpec[] = []
  {
    // sediments + crust fill roughly the top 55% down to basement
    const stackDepth = mohoDepth * lerp(0.42, 0.52, rng())
    let bottom = 0
    let prevTint = -1
    for (let i = 0; i < nLayers; i++) {
      const frac = (i + 1) / nLayers
      bottom = stackDepth * Math.pow(frac, 1.25) * lerp(0.95, 1.05, rng())
      const vp = lerp(2.1, 6.2, Math.pow(frac, 0.8)) * lerp(0.96, 1.04, rng())
      let tint = SEDIMENT_TINTS[Math.floor(rng() * SEDIMENT_TINTS.length)]
      if (tint === prevTint) tint = SEDIMENT_TINTS[(SEDIMENT_TINTS.indexOf(tint) + 1) % SEDIMENT_TINTS.length]
      prevTint = tint
      layers.push({
        bottom,
        vp,
        vs: vp / 1.74,
        att: lerp(0.9986, 0.9993, frac),
        tint,
        hatchAngle: Math.round(((i % 2 === 0 ? 25 : 155) + rng() * 18 - 9) * (235 / 180)),
        hatchDensity: Math.round(lerp(60, 150, frac)),
      })
    }
    // basement (lower crust) down to Moho
    layers.push({
      bottom: mohoDepth,
      vp: lerp(6.5, 6.9, rng()),
      vs: 6.7 / 1.74,
      att: 0.9995,
      tint: 7,
      hatchAngle: Math.round((78 + rng() * 24 - 12) * (235 / 180)),
      hatchDensity: 178,
    })
  }

  // BASIN: soft sediment lens parameters
  const basinCx = W * lerp(0.4, 0.6, rng())
  const basinHalf = W * lerp(0.22, 0.3, rng())
  const basinDepth = lerp(80, 130, rng()) // texels

  // ---- faults -------------------------------------------------------------
  const faults: Fault[] = []
  const addFault = (fx: number, dipDeg: number, dir: 1 | -1, slip: number, sole: number) =>
    faults.push({ fx, dip: (dipDeg * Math.PI) / 180, dir, slip, sole })

  if (archetype === 'FORELAND') {
    const n = 2 + Math.floor(rng() * 2)
    const verg: 1 | -1 = rng() < 0.5 ? 1 : -1
    for (let i = 0; i < n; i++) {
      addFault(W * (0.22 + (0.56 * i) / Math.max(1, n - 1)) + rng() * 40 - 20, lerp(20, 34, rng()), verg, lerp(8, 18, rng()), mohoDepth * 0.5)
    }
  } else if (archetype === 'RIFT') {
    addFault(riftCx - riftHalf, lerp(58, 70, rng()), 1, lerp(10, 20, rng()), mohoDepth * 0.7)
    addFault(riftCx + riftHalf, lerp(58, 70, rng()), -1, lerp(10, 20, rng()), mohoDepth * 0.7)
    if (rng() < 0.4) addFault(riftCx + (rng() - 0.5) * riftHalf, 64, rng() < 0.5 ? 1 : -1, 6, mohoDepth * 0.4)
  } else if (archetype === 'CRATON') {
    if (rng() < 0.45) addFault(W * lerp(0.25, 0.75, rng()), lerp(60, 75, rng()), rng() < 0.5 ? 1 : -1, lerp(4, 9, rng()), mohoDepth * 0.45)
  } else if (archetype === 'BASIN') {
    addFault(basinCx - basinHalf * 1.02, lerp(55, 68, rng()), 1, lerp(7, 13, rng()), mohoDepth * 0.5)
    if (rng() < 0.7) addFault(basinCx + basinHalf * 1.02, lerp(55, 68, rng()), -1, lerp(7, 13, rng()), mohoDepth * 0.5)
  } else if (archetype === 'ARC') {
    // splay thrusts in the forearc
    const inland: 1 | -1 = oceanSide === 1 ? -1 : 1
    addFault(coastX + inland * lerp(60, 120, rng()), lerp(24, 34, rng()), inland, lerp(8, 14, rng()), mohoDepth * 0.4)
    if (rng() < 0.6) addFault(coastX + inland * lerp(180, 260, rng()), lerp(24, 34, rng()), inland, lerp(6, 12, rng()), mohoDepth * 0.35)
  }

  // ---- melt ---------------------------------------------------------------
  const slabDip = ((oceanSide === 1 ? 1 : 1) * lerp(26, 40, rng()) * Math.PI) / 180
  const slabW = lerp(9, 13, rng())
  const hasSlab = archetype === 'ARC'
  const inlandDir: 1 | -1 = oceanSide === 1 ? -1 : 1

  let hasMelt = false
  let meltCx = 0
  let meltCy = 0
  let meltRx = 0
  let meltRy = 0
  if (archetype === 'RIFT' && rng() < 0.7) {
    hasMelt = true
    meltCx = riftCx + (rng() - 0.5) * 30
    meltCy = groundBase + lerp(150, 210, rng())
    meltRx = lerp(34, 55, rng())
    meltRy = lerp(16, 26, rng())
  } else if (archetype === 'ARC') {
    hasMelt = true
    meltCx = coastX + inlandDir * lerp(170, 230, rng())
    meltCy = groundBase + lerp(140, 190, rng())
    meltRx = lerp(26, 40, rng())
    meltRy = lerp(14, 22, rng())
  } else if (rng() < 0.14) {
    hasMelt = true
    meltCx = W * lerp(0.3, 0.7, rng())
    meltCy = groundBase + lerp(160, 220, rng())
    meltRx = lerp(28, 44, rng())
    meltRy = lerp(13, 21, rng())
  }
  meltCx = clamp(meltCx, 70, W - 70)

  // ---- topography ---------------------------------------------------------
  const ground = new Float32Array(W)
  const volcanoX = hasMelt && archetype === 'ARC' ? meltCx + (rng() - 0.5) * 20 : riftLake ? -1 : -1
  for (let x = 0; x < W; x++) {
    let h = groundBase + fbm1(x * 0.006, noiseSeed + 31, 4) * 6
    if (archetype === 'FORELAND') h -= Math.max(0, -fold(x)) * 0.55 + Math.max(0, fold(x)) * 0.15 // ridges over anticlines
    if (archetype === 'CRATON') h += fbm1(x * 0.002, noiseSeed + 37, 3) * 3
    if (archetype === 'RIFT') {
      const d = Math.abs(x - riftCx)
      if (d < riftHalf) h += 10 * (1 - Math.pow(d / riftHalf, 2)) // graben floor sinks
      else h -= 7 * Math.exp(-(((d - riftHalf) / 90) ** 2)) // rift shoulders
    }
    if (archetype === 'BASIN') {
      const d = Math.abs(x - basinCx) / basinHalf
      if (d < 1.15) h += 4 * (1 - Math.min(1, d) ** 2)
    }
    if (hasOcean) {
      const toSea = oceanSide === 1 ? x - coastX : coastX - x
      if (toSea > 0) {
        // shelf → trench → abyssal plain
        const t = Math.min(1, toSea / (W * oceanFrac * 0.55))
        h = lerp(seaLevelY + 2, seaLevelY + lerp(34, 46, 0.5), Math.pow(t, 1.4)) + fbm1(x * 0.01, noiseSeed + 41, 3) * 2
        const trench = Math.exp(-(((toSea - W * oceanFrac * 0.62) / 26) ** 2))
        h += trench * 14
      } else {
        h -= Math.exp(-(-toSea) / 180) * -2 // slight coastal rise inland
        h -= Math.max(0, 8 - -toSea * 0.05)
      }
    }
    if (volcanoX > 0) {
      const d = Math.abs(x - volcanoX)
      h -= 22 * Math.exp(-((d / 34) ** 2)) * (1 + fbm1(x * 0.05, noiseSeed + 43, 2) * 0.15)
    }
    ground[x] = h
  }
  // gentle smoothing pass
  for (let it = 0; it < 2; it++) {
    for (let x = 1; x < W - 1; x++) ground[x] = (ground[x - 1] + ground[x] * 2 + ground[x + 1]) / 4
  }
  for (let x = 0; x < W; x++) ground[x] = clamp(ground[x], H * 0.075, H * 0.34)

  if (riftLake) {
    // ensure graben floor dips under sea level
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x - riftCx)
      if (d < riftHalf * 0.7) ground[x] = Math.max(ground[x], seaLevelY + 8 * (1 - d / (riftHalf * 0.7)))
    }
  }

  // ---- rasterize ----------------------------------------------------------
  const vel = new Float32Array(W * H * 4)
  const style = new Uint8Array(W * H * 4)
  const styleKey = new Int16Array(W * H) // for edge detection

  const faultSide = (f: Fault, x: number, y: number): number => {
    // signed cross product against the downward fault direction
    const dx = f.dir * Math.cos(f.dip)
    const dy = Math.sin(f.dip)
    const px = x - f.fx
    const py = y - groundBase
    return px * dy - py * dx
  }
  const faultDist = (f: Fault, x: number, y: number): number => Math.abs(faultSide(f, x, y))

  const slabAxisDist = (x: number, y: number): number => {
    // distance from the slab center-line, which starts at the trench and dips inland
    const sx = coastX + (oceanSide === 1 ? 1 : -1) * W * oceanFrac * 0.62 // trench x
    const dirx = inlandDir * Math.cos(slabDip)
    const diry = Math.sin(slabDip)
    const px = x - sx
    const py = y - (seaLevelY + 40)
    const along = px * dirx + py * diry
    if (along < 0) return 1e9
    return Math.abs(px * diry - py * dirx)
  }

  let sumVp = 0
  let sumVs = 0
  let nRock = 0

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const gy = ground[x]
      let vp = 0
      let vs = 0
      let att = 0
      let mat = MAT_AIR
      let tint = 0
      let hAng = 0
      let hDen = 0
      let key = 0

      if (y >= gy) {
        // depth below ground with fault displacement + folding
        let yEval = y - gy + fold(x) * (1 - Math.min(1, (y - gy) / mohoDepth) * 0.6)
        for (const f of faults) {
          const s = faultSide(f, x, y)
          if (s > 0) {
            const depthT = clamp(1 - (y - groundBase) / f.sole, 0, 1)
            yEval += f.slip * depthT
          }
        }
        const strat = fbm2(x * 0.012, y * 0.012, noiseSeed + 53, 3) * 3
        yEval += strat

        if (yEval >= mohoDepth) {
          vp = 8.1
          vs = 4.5
          att = 0.9997
          mat = MAT_MANTLE
          tint = 8
          hAng = HATCH_CROSS
          hDen = 150
          key = 90
        } else {
          let li = layers.length - 1
          for (let l = 0; l < layers.length; l++) {
            if (yEval < layers[l].bottom) {
              li = l
              break
            }
          }
          const L = layers[li]
          vp = L.vp
          vs = L.vs
          att = L.att
          mat = MAT_ROCK
          tint = L.tint
          hAng = L.hatchAngle
          hDen = L.hatchDensity
          key = 10 + li
        }

        // BASIN sediment lens overrides upper stack
        if (archetype === 'BASIN') {
          const d = Math.abs(x - basinCx) / basinHalf
          if (d < 1) {
            const lensBottom = gy + basinDepth * Math.sqrt(Math.max(0, 1 - d * d))
            if (y < lensBottom) {
              const fillT = (y - gy) / basinDepth
              const band = Math.floor((y + fold(x) * 0.2) / 14) % 2
              vp = lerp(1.9, 2.8, fillT)
              vs = vp / 1.9
              att = 0.9982
              mat = MAT_ROCK
              tint = band === 0 ? 1 : 2
              hAng = Math.round((band === 0 ? 12 : 168) * (235 / 180))
              hDen = 52
              key = 60 + band
            }
          }
        }

        // slab (high-velocity subducting plate)
        if (hasSlab) {
          const sd = slabAxisDist(x, y)
          if (sd < slabW && mat !== MAT_MANTLE) {
            vp = 8.0
            vs = 4.4
            att = 0.9996
            tint = 8
            hAng = HATCH_SLAB
            hDen = 170
            key = 95
          }
        }

        // melt chamber (liquid: no shear waves)
        if (hasMelt) {
          const ex = (x - meltCx) / meltRx
          const ey = (y - meltCy) / meltRy
          const r2 = ex * ex + ey * ey
          if (r2 < 1) {
            vp = 3.9
            vs = 0
            att = 0.995
            mat = MAT_MELT
            tint = 10
            hAng = HATCH_STIPPLE
            hDen = 200
            key = 99
          } else if (r2 < 1.55) {
            vs *= 0.5 // partial-melt halo
            att = Math.min(att, 0.998)
          }
        }

        // fault damage zone
        for (const f of faults) {
          const y0 = groundBase
          const depthAlong = y - y0
          if (depthAlong > -4 && depthAlong < f.sole && faultDist(f, x, y) < 1.4 && mat === MAT_ROCK) {
            vp *= 0.93
            att = Math.min(att, 0.9988)
          }
        }
      }

      // water fill
      if (seaLevelY > 0 && y >= seaLevelY && y < gy) {
        vp = 1.48
        vs = 0
        att = 0.9992
        mat = MAT_WATER
        tint = 9
        hAng = HATCH_WATER
        hDen = 46
        key = 5
      }

      // sponge boundaries (left/right/bottom)
      const edgeD = Math.min(x, W - 1 - x, H - 1 - y)
      if (edgeD < 26 && mat !== MAT_AIR) {
        const t = edgeD / 26
        att *= lerp(0.86, 1, t * t)
      }

      if (mat === MAT_ROCK || mat === MAT_MANTLE) {
        sumVp += vp
        sumVs += vs
        nRock++
      }

      const o = i * 4
      vel[o] = vp
      vel[o + 1] = vs
      vel[o + 2] = att
      vel[o + 3] = mat
      style[o] = tint
      style[o + 1] = hDen
      style[o + 2] = hAng
      style[o + 3] = 0
      styleKey[i] = key
    }
  }

  // ---- edges (contacts + faults) into style alpha -------------------------
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const kUp = styleKey[i - W]
      const k = styleKey[i]
      if (k !== kUp && k !== 0) {
        style[i * 4 + 3] = kUp === 0 ? 255 : 240 // free surface heavier than internal contacts
      } else if (x > 0 && styleKey[i - 1] !== k && k !== 0 && styleKey[i - 1] !== 0) {
        style[i * 4 + 3] = Math.max(style[i * 4 + 3], 210) // vertical contact
      }
    }
  }
  for (const f of faults) {
    for (let y = Math.floor(groundBase - 2); y < Math.min(H, groundBase + f.sole); y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (vel[i * 4 + 3] !== MAT_ROCK && vel[i * 4 + 3] !== MAT_MANTLE) continue
        if (y >= ground[x] && faultDist(f, x, y) < 1.1) style[i * 4 + 3] = Math.max(style[i * 4 + 3], 160)
      }
    }
  }

  // ---- stations ------------------------------------------------------------
  const stations: number[] = [0.16, 0.5, 0.84].map((f) => {
    let x = Math.round(W * (f + (rng() - 0.5) * 0.05))
    return clamp(x, 30, W - 30)
  })

  // ---- ambient seismicity sites --------------------------------------------
  const quakeSites: QuakeSite[] = []
  for (const f of faults) {
    for (let d = 8; d < f.sole * 0.9; d += 7) {
      const y = groundBase + d
      const x = f.fx + f.dir * Math.cos(f.dip) * (d / Math.sin(f.dip)) * Math.sin(f.dip) // along-dip
      const xx = f.fx + (f.dir * d) / Math.tan(f.dip)
      if (xx > 20 && xx < W - 20 && y < H - 30) quakeSites.push({ x: xx, y, w: 3 })
      void x
    }
  }
  if (hasMelt) {
    for (let a = 0; a < Math.PI * 2; a += 0.45) {
      quakeSites.push({ x: meltCx + Math.cos(a) * meltRx * 1.25, y: meltCy + Math.sin(a) * meltRy * 1.35, w: 2.2 })
    }
  }
  if (hasSlab) {
    // Wadati–Benioff zone: quakes ride the slab down
    const sx = coastX + (oceanSide === 1 ? 1 : -1) * W * oceanFrac * 0.62
    for (let along = 20; along < H * 1.3; along += 12) {
      const x = sx + inlandDir * Math.cos(slabDip) * along
      const y = seaLevelY + 40 + Math.sin(slabDip) * along
      if (x > 20 && x < W - 20 && y > groundBase + 10 && y < H - 30) quakeSites.push({ x, y, w: 4 })
    }
  }
  // background crustal scatter
  for (let k = 0; k < 26; k++) {
    const x = 30 + rng() * (W - 60)
    const y = ground[Math.floor(x)] + 15 + rng() * (mohoDepth * 0.75)
    if (y < H - 30) quakeSites.push({ x, y, w: archetype === 'CRATON' ? 0.35 : 0.8 })
  }

  // ---- naming ---------------------------------------------------------------
  const meltKm = hasMelt ? ((meltCy - groundBase) * KM_PER_TEXEL).toFixed(0) : ''
  const flavors: Record<Archetype, [string, string]> = {
    CRATON: ['CRATONIC SHIELD', 'OLD, COLD & QUIET — LONG CLEAN TRANSMISSION'],
    FORELAND: [`FOLDED FORELAND · ${faults.length} THRUST${faults.length === 1 ? '' : 'S'}`, 'RIDGES RIDE THE ANTICLINES'],
    RIFT: [hasMelt ? `RIFT GRABEN · MELT AT ${meltKm} KM` : 'RIFT GRABEN', hasMelt ? 'S-WAVES CANNOT CROSS LIQUID — WATCH THE SHADOW' : 'TWIN NORMAL FAULTS BOUND THE TROUGH'],
    ARC: [`VOLCANIC ARC · SLAB DIP ${Math.round((slabDip * 180) / Math.PI)}°`, 'DEEP QUAKES RIDE THE SLAB DOWN'],
    BASIN: ['DEEP SEDIMENT BASIN', 'SOFT FILL RINGS LIKE A BELL — SITE AMPLIFICATION'],
  }
  const [name, note] = flavors[archetype]

  return {
    seed,
    archetype,
    title: `PLATE ${roman(plateNo)} — ${name}`,
    note,
    W,
    H,
    vel,
    style,
    groundY: ground,
    seaLevelY,
    hasWater: seaLevelY > 0,
    hasMelt,
    stations,
    quakeSites,
    avgVp: nRock ? sumVp / nRock : 5.5,
    avgVs: nRock ? sumVs / nRock : 3.2,
  }
}
