/** Thin WebGL2 helpers: program compilation with cached uniforms, textures, FBOs, one shared quad. */

export class Prog {
  prog: WebGLProgram
  private uniforms = new Map<string, WebGLUniformLocation | null>()

  constructor(
    private gl: WebGL2RenderingContext,
    vsSrc: string,
    fsSrc: string,
    label: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, label + '.vert')
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, label + '.frag')
    const p = gl.createProgram()
    if (!p) throw new Error('createProgram failed')
    gl.attachShader(p, vs)
    gl.attachShader(p, fs)
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`link ${label}: ${gl.getProgramInfoLog(p)}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    this.prog = p
  }

  use(): void {
    this.gl.useProgram(this.prog)
  }

  u(name: string): WebGLUniformLocation | null {
    let loc = this.uniforms.get(name)
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(this.prog, name)
      this.uniforms.set(name, loc)
    }
    return loc
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`compile ${label}: ${gl.getShaderInfoLog(sh)}`)
  }
  return sh
}

export interface TexOpts {
  internal: number
  format: number
  type: number
  filter: number
}

export function createTex(gl: WebGL2RenderingContext, w: number, h: number, o: TexOpts, data: ArrayBufferView | null = null): WebGLTexture {
  const t = gl.createTexture()
  if (!t) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, o.filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, o.internal, w, h, 0, o.format, o.type, data as never)
  return t
}

export function createFBO(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const f = gl.createFramebuffer()
  if (!f) throw new Error('createFramebuffer failed')
  gl.bindFramebuffer(gl.FRAMEBUFFER, f)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO incomplete: 0x${status.toString(16)}`)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return f
}

/** Fullscreen quad whose v coordinate runs 0 at the TOP (matches world/texel space, row 0 = sky). */
export function createQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()
  if (!vao) throw new Error('createVertexArray failed')
  gl.bindVertexArray(vao)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  // x, y (clip), u, v — v flipped so v=0 at clip-space top
  const data = new Float32Array([
    -1, -1, 0, 1,
    3, -1, 2, 1,
    -1, 3, 0, -1,
  ])
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)
  gl.bindVertexArray(null)
  return vao
}
