/**
 * All GLSL. Five programs share one fullscreen-triangle vertex shader:
 *   SIM       — leapfrog update of two damped scalar wave fields (P in RG, S in BA)
 *   ENERGY    — max-hold shaking-intensity accumulator with decay
 *   PROBE     — samples the field at station texels, packs 16-bit fixed point into RGBA8
 *   PLATE     — the static engraved plate (paper, hatching, contacts) per lens family
 *   COMPOSITE — plate × living wavefield × energy + grain, per lens
 */

export const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
out vec2 vUV;
void main(){ vUV = aUV; gl_Position = vec4(aPos, 0.0, 1.0); }
`

export const FRAG_SIM = `#version 300 es
precision highp float;
uniform sampler2D uField; // R=P G=Pprev B=S A=Sprev
uniform sampler2D uVel;   // vp km/s, vs km/s, attenuation, material
uniform float uDtDx;      // dt/dx  (courant = v * uDtDx)
uniform float uSimTime;   // s, at start of this substep
uniform int uNumSrc;
uniform vec4 uSrcA[8];    // x, y (texels, y from top), amp, sigma
uniform vec4 uSrcB[8];    // t0, freq, faultAngle, unused
out vec4 outF;

void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uField, 0) - 1;
  vec4 v = texelFetch(uVel, p, 0);
  if (v.x <= 0.001) { outF = vec4(0.0); return; } // air stays silent

  vec4 f  = texelFetch(uField, p, 0);
  vec4 fl = texelFetch(uField, ivec2(max(p.x-1,0), p.y), 0);
  vec4 fr = texelFetch(uField, ivec2(min(p.x+1,sz.x), p.y), 0);
  vec4 ft = texelFetch(uField, ivec2(p.x, max(p.y-1,0)), 0);
  vec4 fb = texelFetch(uField, ivec2(p.x, min(p.y+1,sz.y)), 0);

  float lapP = fl.x + fr.x + ft.x + fb.x - 4.0*f.x;
  float lapS = fl.z + fr.z + ft.z + fb.z - 4.0*f.z;

  float cp = v.x * uDtDx;
  float cs = v.y * uDtDx;
  float nP = 2.0*f.x - f.y + cp*cp*lapP;
  float nS = 2.0*f.z - f.w + cs*cs*lapS;

  for (int i = 0; i < 8; i++){
    if (i >= uNumSrc) break;
    vec4 A = uSrcA[i];
    vec4 B = uSrcB[i];
    float tau = uSimTime - B.x;
    if (tau < 0.0) continue;
    vec2 d = gl_FragCoord.xy - vec2(0.5) - A.xy;
    float r2 = dot(d, d);
    float s2 = 2.0 * A.w * A.w;
    if (r2 > s2 * 9.0) continue;
    float g = exp(-r2 / s2);
    float pf = 3.14159265 * B.y * (tau - 1.1 / B.y); // delayed ricker
    float ric = (1.0 - 2.0*pf*pf) * exp(-pf*pf);
    float r = sqrt(r2);
    float th = atan(d.y, d.x) - B.z;
    // double-couple radiation: quadrupolar P, complementary S
    float radP = mix(1.0, cos(2.0*th), smoothstep(0.0, A.w*1.6, r));
    float radS = sin(2.0*th) * smoothstep(0.0, A.w*0.7, r);
    nP += A.z * ric * g * radP;
    if (v.y > 0.01) nS += A.z * ric * g * radS * 0.9;
  }

  nP = clamp(nP * v.z, -48.0, 48.0);
  nS = clamp(nS * v.z, -48.0, 48.0);
  outF = vec4(nP, f.x, nS, f.z);
}
`

export const FRAG_ENERGY = `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform sampler2D uPrev;
uniform float uDecay;
out vec4 outE;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 f = texelFetch(uField, p, 0);
  float e = texelFetch(uPrev, p, 0).r;
  float a = tanh((abs(f.x) + abs(f.z)) * 1.25);
  outE = vec4(max(e * uDecay, a), 0.0, 0.0, 1.0);
}
`

export const FRAG_PROBE = `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform vec2 uProbe[8];
out vec4 o;
void main(){
  int i = int(gl_FragCoord.x);
  vec4 f = texelFetch(uField, ivec2(uProbe[i]), 0);
  float P = clamp(f.x/16.0 + 0.5, 0.0, 1.0);
  float S = clamp(f.z/16.0 + 0.5, 0.0, 1.0);
  float Pn = floor(P*65535.0 + 0.5);
  float Sn = floor(S*65535.0 + 0.5);
  o = vec4(floor(Pn/256.0)/255.0, mod(Pn,256.0)/255.0, floor(Sn/256.0)/255.0, mod(Sn,256.0)/255.0);
}
`

/** Shared noise helpers injected into plate + composite. */
const NOISE = `
float hash21(vec2 p){
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int o = 0; o < 4; o++){ s += a * vnoise(p); p = p * 2.03 + 17.7; a *= 0.5; }
  return s;
}
`

export const FRAG_PLATE = `#version 300 es
precision highp float;
uniform sampler2D uStyle;   // tint idx /255, hatch density, hatch angle code, edge
uniform sampler2D uVel;     // vp, vs, att, mat
uniform vec2 uRes;          // canvas px
uniform float uVariant;     // 0 = section, 1 = x-ray, 2 = darkfield
uniform float uSeed;
in vec2 vUV;
out vec4 outC;
${NOISE}

const vec3 INK    = vec3(0.135, 0.114, 0.086);
const vec3 REDINK = vec3(0.478, 0.173, 0.125);
const vec3 PAPER  = vec3(0.914, 0.869, 0.760);

vec3 tintColor(int idx){
  if (idx == 0) return vec3(0.930, 0.891, 0.792); // sky
  if (idx == 1) return vec3(0.886, 0.828, 0.665); // pale buff
  if (idx == 2) return vec3(0.851, 0.771, 0.610); // warm umber
  if (idx == 3) return vec3(0.812, 0.790, 0.630); // olive drab
  if (idx == 4) return vec3(0.762, 0.766, 0.671); // gray-green slate
  if (idx == 5) return vec3(0.851, 0.749, 0.628); // dusty rose
  if (idx == 6) return vec3(0.843, 0.812, 0.700); // pale gray
  if (idx == 7) return vec3(0.704, 0.676, 0.575); // deep slate
  if (idx == 8) return vec3(0.780, 0.663, 0.529); // mantle sienna
  if (idx == 9) return vec3(0.808, 0.828, 0.749); // water wash
  if (idx == 10) return vec3(0.775, 0.549, 0.412); // melt
  return PAPER;
}

float stripeLine(vec2 px, float ang, float spacing, float duty){
  vec2 dir = vec2(cos(ang), sin(ang));
  float s = dot(px, dir) * (6.2831853 / spacing);
  float w = 0.5 + 0.5 * sin(s);
  return smoothstep(duty, duty + 0.22, w);
}

void main(){
  // rendering into an FBO: clip-space top writes to high texel rows, so flip v
  // to keep world row 0 (sky) at the top of the plate texture's screen mapping
  vec2 uv = vec2(vUV.x, 1.0 - vUV.y);
  vec2 px = vUV * uRes;
  // hand-wobble so nothing reads as vector-perfect
  vec2 wob = vec2(fbm(px * 0.021 + uSeed), fbm(px * 0.021 + 40.0 - uSeed)) - 0.5;
  vec2 uvw = uv + wob * 0.0022;
  vec4 st = texture(uStyle, uvw);
  float den = st.g;
  float angByte = st.b * 255.0;
  float edge = st.a;
  int tint = int(st.r * 255.0 + 0.5);
  bool isAir = den < 0.004 && tint == 0;

  float grain = fbm(px * 0.13 + uSeed * 7.0);
  float mottle = fbm(px * 0.011 - uSeed * 3.0);

  vec3 col;
  float inkAmt = 0.0;
  vec3 inkCol = INK;

  if (uVariant < 0.5) {
    // ---------------- SECTION: engraved geology ----------------
    vec3 base = tintColor(tint);
    base *= 0.965 + grain * 0.06;
    base *= 0.985 - (mottle - 0.5) * 0.09;
    col = base;
    if (!isAir) {
      float h = 0.0;
      if (angByte > 248.0) { // mantle cross-hatch
        h = max(stripeLine(px + wob*9.0, 0.75, 6.2, 0.62), stripeLine(px + wob*9.0, -0.72, 6.4, 0.66)) * 0.42;
      } else if (angByte > 244.0) { // melt stipple
        vec2 cell = floor(px / 4.6);
        vec2 cp = fract(px / 4.6) - 0.5;
        float dot_ = 1.0 - smoothstep(0.14, 0.3, length(cp + (vec2(hash21(cell), hash21(cell+9.1)) - 0.5) * 0.5));
        h = dot_ * step(hash21(cell + 3.7), 0.62) * 0.62;
      } else if (angByte > 240.0) { // water: broken horizontal liner
        float row = floor(px.y / 7.0);
        float ln = stripeLine(px + wob*14.0, 0.0, 7.0, 0.80);
        float gaps = step(0.34, vnoise(vec2(px.x * 0.02, row * 5.3)));
        h = ln * gaps * 0.34;
      } else if (angByte > 236.0) { // slab: dense oblique + faint cross
        h = stripeLine(px + wob*7.0, 0.52, 4.6, 0.58) * 0.5;
        h = max(h, stripeLine(px + wob*7.0, 2.1, 9.0, 0.75) * 0.22);
      } else {
        float ang = angByte / 235.0 * 3.14159265;
        float spacing = mix(9.5, 4.0, den);
        float duty = mix(0.86, 0.55, den);
        h = stripeLine(px + wob * 11.0, ang, spacing, duty) * mix(0.2, 0.5, den);
        // second finer set for the deepest units
        if (den > 0.62) h = max(h, stripeLine(px + wob * 11.0, ang + 1.35, spacing * 2.1, 0.8) * 0.2);
      }
      inkAmt = h * (0.82 + grain * 0.35);
    } else {
      // sky: barely-there horizontal atmosphere lines fading toward the horizon
      float atmo = stripeLine(px + wob*16.0, 0.0, 5.4, 0.965) * smoothstep(0.02, 0.16, uv.y) * 0.05;
      inkAmt = atmo;
    }
  } else if (uVariant < 1.5) {
    // ---------------- X-RAY: velocity tomograph ----------------
    // manual bilinear on the (NEAREST) float velocity texture
    vec2 vsz = vec2(textureSize(uVel, 0));
    vec2 st2 = uvw * vsz - 0.5;
    vec2 ip2 = floor(st2);
    vec2 f2 = fract(st2);
    ivec2 mx2 = ivec2(vsz) - 1;
    vec4 va = texelFetch(uVel, clamp(ivec2(ip2), ivec2(0), mx2), 0);
    vec4 vb = texelFetch(uVel, clamp(ivec2(ip2) + ivec2(1,0), ivec2(0), mx2), 0);
    vec4 vc = texelFetch(uVel, clamp(ivec2(ip2) + ivec2(0,1), ivec2(0), mx2), 0);
    vec4 vd = texelFetch(uVel, clamp(ivec2(ip2) + ivec2(1,1), ivec2(0), mx2), 0);
    vec4 vel = mix(mix(va, vb, f2.x), mix(vc, vd, f2.x), f2.y);
    if (isAir) {
      col = PAPER * (0.97 + grain * 0.05);
    } else {
      float t = clamp((vel.x - 1.3) / 7.0, 0.0, 1.0);
      vec3 slow = vec3(0.895, 0.855, 0.742);
      vec3 mid  = vec3(0.545, 0.596, 0.561);
      vec3 fast = vec3(0.212, 0.257, 0.278);
      col = t < 0.5 ? mix(slow, mid, t*2.0) : mix(mid, fast, t*2.0 - 1.0);
      col *= 0.97 + grain * 0.05;
      // velocity contours every 1 km/s, anti-aliased
      float cv = fract(vel.x);
      float dist = min(cv, 1.0 - cv);
      float fw = fwidth(vel.x) + 0.012;
      float ct = 1.0 - smoothstep(0.0, fw * 1.6, dist);
      inkAmt = ct * 0.26;
      // liquid (no shear) marked with red stipple
      if (vel.y < 0.01 && vel.x > 2.0) {
        vec2 cell = floor(px / 5.0);
        float dot_ = step(hash21(cell), 0.5);
        inkAmt = max(inkAmt, dot_ * 0.4);
        inkCol = REDINK;
      }
    }
  } else {
    // ---------------- DARKFIELD: night scope ----------------
    vec3 base = vec3(0.075, 0.066, 0.050);
    base *= 0.9 + grain * 0.25;
    col = base;
    if (!isAir) {
      float ang = angByte > 236.0 ? 0.6 : angByte / 235.0 * 3.14159265;
      float h = stripeLine(px + wob * 11.0, ang, 8.0, 0.88) * 0.045;
      col += vec3(0.86, 0.80, 0.62) * h * den;
    }
    inkCol = vec3(0.86, 0.80, 0.62);
  }

  // contacts, surface, faults
  float e = edge;
  if (e > 0.05) {
    float w = 0.0;
    vec3 ec = uVariant > 1.5 ? vec3(0.62, 0.57, 0.44) : INK;
    if (e > 0.965) w = 0.88;            // free surface / sea surface
    else if (e > 0.90) w = 0.62;        // layer contact
    else if (e > 0.78) w = 0.40;        // vertical contact
    else { w = 0.55; ec = mix(ec, REDINK, 0.75); } // fault
    if (uVariant > 1.5) { col = mix(col, ec, w * 0.8); }
    else { inkAmt = max(inkAmt, w); inkCol = mix(inkCol, ec, e < 0.78 ? 1.0 : 0.0); }
  }

  if (uVariant > 1.5) {
    outC = vec4(col, 0.0);
  } else {
    col = mix(col, inkCol, inkAmt);
    outC = vec4(col, inkAmt);
  }
}
`

export const FRAG_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uPlate;
uniform sampler2D uField;
uniform sampler2D uEnergy;
uniform vec2 uSimSize;
uniform vec2 uRes;
uniform float uLens;   // 0 section, 1 energy, 2 x-ray, 3 darkfield
uniform float uTime;
uniform vec4 uFlash;   // x, y (texel), age 0-1, mag01
in vec2 vUV;
out vec4 outC;
${NOISE}

const vec3 P_INK   = vec3(0.137, 0.176, 0.322); // indigo
const vec3 S_INK   = vec3(0.529, 0.157, 0.102); // madder red
const vec3 SCORCH  = vec3(0.318, 0.184, 0.102);
const vec3 PAPER   = vec3(0.914, 0.869, 0.760);

vec4 bil(sampler2D t, vec2 uv, out vec4 gx, out vec4 gy){
  vec2 st = uv * uSimSize - 0.5;
  vec2 ip = floor(st);
  vec2 f = fract(st);
  ivec2 i0 = ivec2(ip);
  ivec2 mx = ivec2(uSimSize) - 1;
  vec4 a = texelFetch(t, clamp(i0,               ivec2(0), mx), 0);
  vec4 b = texelFetch(t, clamp(i0 + ivec2(1,0), ivec2(0), mx), 0);
  vec4 c = texelFetch(t, clamp(i0 + ivec2(0,1), ivec2(0), mx), 0);
  vec4 d = texelFetch(t, clamp(i0 + ivec2(1,1), ivec2(0), mx), 0);
  gx = mix(b - a, d - c, f.y);
  gy = mix(c - a, d - b, f.x);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main(){
  vec2 px = vUV * uRes;
  vec4 plate = texture(uPlate, vUV);
  vec3 col = plate.rgb;

  vec4 gx, gy, egx, egy;
  vec4 f = bil(uField, vUV, gx, gy);
  float e = bil(uEnergy, vUV, egx, egy).r;

  // soft knee: suppress the faint long coda, keep fronts crisp
  float aP = abs(f.x);
  float aS = abs(f.z);
  float ampP = tanh(aP * aP / (aP + 0.045) * 3.4);
  float ampS = tanh(aS * aS / (aS + 0.045) * 3.4);

  // wavefront engraving: fine lines perpendicular to propagation
  vec2 gP = vec2(gx.x, gy.x);
  vec2 gS = vec2(gx.z, gy.z);
  float gPm = length(gP);
  float gSm = length(gS);
  vec2 dP = gP / max(gPm, 1e-6);
  vec2 dS = gS / max(gSm, 1e-6);
  float hatchP = (0.5 + 0.5 * sin(dot(px, dP) * 1.35)) * min(1.0, gPm * 26.0);
  float hatchS = (0.5 + 0.5 * sin(dot(px, dS) * 1.35)) * min(1.0, gSm * 26.0);

  if (uLens < 2.5) {
    float wP = clamp(ampP * (0.72 + 0.5 * hatchP), 0.0, 1.0);
    float wS = clamp(ampS * (0.72 + 0.5 * hatchS), 0.0, 1.0);
    if (uLens > 0.5 && uLens < 1.5) { wP *= 0.30; wS *= 0.30; }
    if (uLens > 1.5) {
      // x-ray: waves as a restrained luminance lift over the tomograph
      col = mix(col, PAPER, clamp(ampP * 0.5 + ampS * 0.32, 0.0, 0.55));
    } else {
      // polarity gives the ink a two-tone wash
      vec3 pInk = mix(P_INK * 1.55, P_INK * 0.72, step(0.0, f.x));
      vec3 sInk = mix(S_INK * 1.55, S_INK * 0.72, step(0.0, f.z));
      col = mix(col, pInk, wP * 0.88);
      col = mix(col, sInk, wS * 0.82);
    }
    // shaking memory
    if (uLens > 0.5 && uLens < 1.5) {
      float es = pow(clamp(e, 0.0, 1.0), 1.7);
      float eq = floor(es * 7.0) / 7.0;
      float band = fract(es * 7.0);
      float line = 1.0 - smoothstep(0.0, 0.14, min(band, 1.0 - band));
      col = mix(col, SCORCH, eq * 0.5);
      col = mix(col, SCORCH * 0.5, line * smoothstep(0.02, 0.1, es) * (1.0 - smoothstep(0.9, 0.99, es)) * 0.55);
    } else {
      col = mix(col, SCORCH, e * 0.10);
    }
  } else {
    // darkfield: additive phosphor
    vec3 glowP = vec3(0.42, 0.75, 0.95);
    vec3 glowS = vec3(1.0, 0.52, 0.22);
    col += glowP * pow(ampP, 1.5) * (0.72 + 0.42 * hatchP);
    col += glowS * pow(ampS, 1.5) * (0.68 + 0.42 * hatchS);
    col += vec3(0.55, 0.25, 0.08) * e * 0.12;
  }

  // rupture flash: expanding annotation ring + brief paper lift
  if (uFlash.z > 0.001 && uFlash.z < 1.0) {
    vec2 fpx = uFlash.xy / uSimSize * uRes;
    float r = distance(px, fpx);
    float ringR = uFlash.z * (240.0 + 260.0 * uFlash.w);
    float ring = exp(-abs(r - ringR) * 0.09) * (1.0 - uFlash.z);
    vec3 rc = uLens > 2.5 ? vec3(1.0, 0.85, 0.6) : mix(vec3(0.36, 0.1, 0.06), PAPER, 0.15);
    col = mix(col, rc, ring * 0.5);
    float lift = exp(-r * 0.012) * max(0.0, 0.22 - uFlash.z) * 3.0;
    col = mix(col, uLens > 2.5 ? vec3(1.0, 0.9, 0.7) : PAPER, lift * 0.55 * uFlash.w);
  }

  // living print: animated grain + vignette
  float g = hash21(px + fract(uTime * 61.7));
  col *= 0.978 + g * 0.044;
  vec2 vc = (vUV - 0.5) * vec2(1.12, 1.0);
  col *= mix(0.93, 1.0, smoothstep(0.95, 0.42, length(vc)));

  outC = vec4(col, 1.0);
}
`
