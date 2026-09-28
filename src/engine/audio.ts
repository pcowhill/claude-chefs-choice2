/**
 * Observatory sound, synthesized — no samples. Off until the user throws the
 * AUDIO switch (which is the required user gesture for the AudioContext).
 *
 *   bed     brown noise → lowpass, gain follows total station motion
 *   sub     32 Hz sine keyed to shear amplitude
 *   thump   filtered burst + decaying sine on each picked arrival
 *   click   tiny switch blip for panel controls
 */

export class ObservatoryAudio {
  enabled = false
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private bedGain: GainNode | null = null
  private bedFilter: BiquadFilterNode | null = null
  private subGain: GainNode | null = null

  async enable(): Promise<void> {
    if (!this.ctx) {
      const ctx = new AudioContext()
      this.ctx = ctx
      const master = ctx.createGain()
      master.gain.value = 0.85
      master.connect(ctx.destination)
      this.master = master

      // brown noise bed
      const len = ctx.sampleRate * 2
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = buf.getChannelData(0)
      let last = 0
      for (let i = 0; i < len; i++) {
        last = Math.max(-1, Math.min(1, last + (Math.random() * 2 - 1) * 0.035))
        d[i] = last * 2.8
      }
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 70
      filter.Q.value = 0.7
      const gain = ctx.createGain()
      gain.gain.value = 0
      src.connect(filter).connect(gain).connect(master)
      src.start()
      this.bedFilter = filter
      this.bedGain = gain

      // sub sine
      const sub = ctx.createOscillator()
      sub.type = 'sine'
      sub.frequency.value = 33
      const sg = ctx.createGain()
      sg.gain.value = 0
      sub.connect(sg).connect(master)
      sub.start()
      this.subGain = sg
    }
    await this.ctx.resume()
    this.enabled = true
  }

  async disable(): Promise<void> {
    this.enabled = false
    if (this.ctx) await this.ctx.suspend()
  }

  /** Per-frame: amp = combined |velocity| across stations, shear = S-channel share. */
  frame(amp: number, shear: number): void {
    if (!this.enabled || !this.ctx || !this.bedGain || !this.bedFilter || !this.subGain) return
    const t = this.ctx.currentTime
    const g = Math.tanh(amp * 1.6) * 0.5
    this.bedGain.gain.setTargetAtTime(g, t, 0.09)
    this.bedFilter.frequency.setTargetAtTime(60 + Math.tanh(amp) * 240, t, 0.12)
    this.subGain.gain.setTargetAtTime(Math.tanh(shear * 2.0) * 0.22, t, 0.1)
  }

  /** Arrival transient. deep = S phase (lower, longer). */
  thump(strength: number, deep: boolean): void {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const s = Math.min(1, strength)

    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(deep ? 30 : 44, t)
    osc.frequency.exponentialRampToValueAtTime(deep ? 22 : 30, t + 0.4)
    const og = ctx.createGain()
    og.gain.setValueAtTime(0.34 * s, t)
    og.gain.exponentialRampToValueAtTime(0.001, t + (deep ? 0.7 : 0.45))
    osc.connect(og).connect(this.master)
    osc.start(t)
    osc.stop(t + 0.8)

    const n = ctx.createBufferSource()
    const len = Math.floor(ctx.sampleRate * 0.22)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
    n.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = deep ? 120 : 220
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.22 * s, t)
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
    n.connect(f).connect(ng).connect(this.master)
    n.start(t)
  }

  /** Panel switch blip. */
  click(): void {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 660
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 1600
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.05, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.045)
    osc.connect(f).connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + 0.06)
  }
}
