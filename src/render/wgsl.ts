/**
 * WGSL for the WebGPU pipeline. Pass order (each a full-screen triangle):
 *
 *   ingest (external | planar)  ->  [deband]  ->  [scale: bicubic/lanczos | EASU]  ->  final (RCAS + dither)
 *
 * Intermediates are rgba16float holding gamma-encoded, display-referred BT.709 RGB.
 */

const COMMON = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

// Sample position for a picture that must be shown rotated clockwise by rot quarter turns.
fn rotUv(uv: vec2f, rot: u32) -> vec2f {
  if (rot == 1u) { return vec2f(uv.y, 1.0 - uv.x); }
  if (rot == 2u) { return vec2f(1.0 - uv.x, 1.0 - uv.y); }
  if (rot == 3u) { return vec2f(1.0 - uv.y, uv.x); }
  return uv;
}

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

export const WGSL_INGEST_EXTERNAL = /* wgsl */ `
${COMMON}
struct U { mode: vec4u };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_external;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSampleBaseClampToEdge(tex, samp, rotUv(in.uv, u.mode.w));
  return vec4f(c.rgb, 1.0);
}
`;

export const WGSL_INGEST_PLANAR = /* wgsl */ `
${COMMON}
struct U {
  m0: vec4f,
  m1: vec4f,
  m2: vec4f,
  off: vec4f,
  scl: vec4f,
  pack: vec4f,   // xy = code packing, z = source peak in nits
  mode: vec4u,   // x = transfer (0 sdr, 1 pq, 2 hlg), y = primaries (0 709, 1 2020, 2 p3), z = tone map, w = rotation
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texY: texture_2d<f32>;
@group(0) @binding(3) var texU: texture_2d<f32>;
@group(0) @binding(4) var texV: texture_2d<f32>;

const PQ_M1 = 0.1593017578125;
const PQ_M2 = 78.84375;
const PQ_C1 = 0.8359375;
const PQ_C2 = 18.8515625;
const PQ_C3 = 18.6875;
const SDR_WHITE = 203.0;

// SMPTE ST 2084: signal -> luminance / 10000 nits
fn pqEotf(e: vec3f) -> vec3f {
  let p = pow(max(e, vec3f(0.0)), vec3f(1.0 / PQ_M2));
  return pow(max(p - PQ_C1, vec3f(0.0)) / (PQ_C2 - PQ_C3 * p), vec3f(1.0 / PQ_M1));
}
fn pqOetf1(y: f32) -> f32 {
  let p = pow(max(y, 0.0), PQ_M1);
  return pow((PQ_C1 + PQ_C2 * p) / (1.0 + PQ_C3 * p), PQ_M2);
}
fn pqEotf1(e: f32) -> f32 {
  let p = pow(max(e, 0.0), 1.0 / PQ_M2);
  return pow(max(p - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * p), 1.0 / PQ_M1);
}

// ARIB STD-B67 inverse OETF + OOTF for a 1000-nit display, result in nits / 1000
fn hlgToDisplay(e: vec3f) -> vec3f {
  let a = 0.17883277;
  let b = 0.28466892;
  let c = 0.55991073;
  let lo = e * e / 3.0;
  let hi = (exp((e - c) / a) + b) / 12.0;
  let scene = select(hi, lo, e <= vec3f(0.5));
  let ys = dot(scene, vec3f(0.2627, 0.6780, 0.0593));
  return scene * pow(max(ys, 1e-6), 0.2);
}

fn hable(x: f32) -> f32 {
  let A = 0.15; let B = 0.50; let C = 0.10; let D = 0.20; let E = 0.02; let F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

// x and peak are linear, relative to SDR reference white. Returns <= 1.
fn toneCurve(x: f32, peak: f32, kind: u32) -> f32 {
  if (kind == 3u) { return min(x, 1.0); }
  if (kind == 2u) { return x * (1.0 + x / (peak * peak)) / (1.0 + x); }
  if (kind == 1u) { return hable(x) / hable(peak); }
  // ITU-R BT.2390 EETF, evaluated in PQ space normalised to the source peak.
  let srcPq = pqOetf1(peak * SDR_WHITE / 10000.0);
  let dstPq = pqOetf1(SDR_WHITE / 10000.0);
  let e1 = pqOetf1(x * SDR_WHITE / 10000.0) / srcPq;
  let maxLum = dstPq / srcPq;
  let ks = 1.5 * maxLum - 0.5;
  var e2 = e1;
  if (e1 > ks) {
    let t = (e1 - ks) / (1.0 - ks);
    let t2 = t * t;
    let t3 = t2 * t;
    e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * ks + (t3 - 2.0 * t2 + t) * (1.0 - ks) + (-2.0 * t3 + 3.0 * t2) * maxLum;
  }
  return pqEotf1(e2 * srcPq) * 10000.0 / SDR_WHITE;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let uv = rotUv(in.uv, u.mode.w);
  let y = dot(textureSampleLevel(texY, samp, uv, 0.0).rg, u.pack.xy);
  let cb = dot(textureSampleLevel(texU, samp, uv, 0.0).rg, u.pack.xy);
  let cr = dot(textureSampleLevel(texV, samp, uv, 0.0).rg, u.pack.xy);
  let yuv = (vec3f(y, cb, cr) - u.off.xyz) * u.scl.xyz;
  var rgb = vec3f(dot(u.m0.xyz, yuv), dot(u.m1.xyz, yuv), dot(u.m2.xyz, yuv));

  if (u.mode.x != 0u || u.mode.y != 0u) {
    var lin: vec3f;
    if (u.mode.x == 1u) {
      lin = pqEotf(clamp(rgb, vec3f(0.0), vec3f(1.0))) * (10000.0 / SDR_WHITE);
    } else if (u.mode.x == 2u) {
      lin = hlgToDisplay(clamp(rgb, vec3f(0.0), vec3f(1.0))) * (1000.0 / SDR_WHITE);
    } else {
      lin = pow(max(rgb, vec3f(0.0)), vec3f(2.4));
    }
    if (u.mode.x != 0u) {
      let peak = max(u.pack.z / SDR_WHITE, 1.0);
      let m = max(max(lin.r, lin.g), max(lin.b, 1e-6));
      lin *= toneCurve(min(m, peak), peak, u.mode.z) / m;
    }
    if (u.mode.y == 1u) {
      lin = vec3f(
        dot(vec3f(1.6605, -0.5876, -0.0728), lin),
        dot(vec3f(-0.1246, 1.1329, -0.0083), lin),
        dot(vec3f(-0.0182, -0.1006, 1.1187), lin));
    } else if (u.mode.y == 2u) {
      lin = vec3f(
        dot(vec3f(1.2249, -0.2247, 0.0), lin),
        dot(vec3f(-0.0420, 1.0419, 0.0), lin),
        dot(vec3f(-0.0197, -0.0786, 1.0979), lin));
    }
    rgb = pow(clamp(lin, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.4));
  }
  return vec4f(rgb, 1.0);
}
`;

export const WGSL_DEBAND = /* wgsl */ `
${COMMON}
struct U { p: vec4f };   // threshold, range (px), grain, frame counter
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(tex, samp, uv, 0.0).rgb; }

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(tex));
  let pt = 1.0 / size;
  var col = tap(in.uv);
  let seed = in.pos.xy + fract(u.p.w * 0.6180339887) * 289.0;
  // mpv/libplacebo style: compare against the average of 4 taps at a random distance and angle,
  // replace when the difference is below a threshold that tightens with each iteration.
  for (var i = 1; i <= 2; i++) {
    let fi = f32(i);
    let dist = hash12(seed + fi * 17.13) * u.p.y * fi;
    let ang = hash12(seed.yx + fi * 71.37) * 6.2831853;
    let o = vec2f(cos(ang), sin(ang)) * dist * pt;
    let avg = 0.25 * (tap(in.uv + o) + tap(in.uv - o) + tap(in.uv + vec2f(-o.y, o.x)) + tap(in.uv + vec2f(o.y, -o.x)));
    let diff = abs(col - avg);
    col = mix(avg, col, step(vec3f(u.p.x / fi), diff));
  }
  let g = vec3f(hash12(seed * 1.31), hash12(seed * 1.73 + 5.0), hash12(seed * 2.11 + 11.0)) - 0.5;
  return vec4f(col + g * u.p.z, 1.0);
}
`;

export const WGSL_SCALE = /* wgsl */ `
${COMMON}
struct U {
  size: vec4f,   // src w,h, dst w,h
  opt: vec4f,    // kernel (0 bilinear, 1 bicubic, 2 lanczos3), anti-ring, linear-light, unused
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

fn kern(x: f32, k: f32) -> f32 {
  let ax = abs(x);
  if (k < 1.5) {
    // Catmull-Rom (B = 0, C = 0.5)
    if (ax < 1.0) { return (1.5 * ax - 2.5) * ax * ax + 1.0; }
    if (ax < 2.0) { return ((-0.5 * ax + 2.5) * ax - 4.0) * ax + 2.0; }
    return 0.0;
  }
  if (ax < 1e-5) { return 1.0; }
  if (ax >= 3.0) { return 0.0; }
  let px = 3.14159265 * ax;
  return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  if (u.opt.x < 0.5) {
    return vec4f(textureSampleLevel(tex, samp, in.uv, 0.0).rgb, 1.0);
  }
  let src = u.size.xy;
  let dst = u.size.zw;
  // When downscaling the kernel is stretched so it low-pass filters (no aliasing).
  let ratio = max(src / dst, vec2f(1.0));
  let support = select(2.0, 3.0, u.opt.x > 1.5);
  let p = in.uv * src - 0.5;
  let base = floor(p);
  let f = p - base;
  let rad = vec2i(min(ceil(support * ratio), vec2f(8.0)));
  let maxc = vec2i(src) - 1;
  let linear = u.opt.z > 0.5;
  var acc = vec3f(0.0);
  var wsum = 0.0;
  var lo = vec3f(1e9);
  var hi = vec3f(-1e9);
  for (var j = 1 - rad.y; j <= rad.y; j++) {
    let wy = kern((f32(j) - f.y) / ratio.y, u.opt.x);
    for (var i = 1 - rad.x; i <= rad.x; i++) {
      let w = wy * kern((f32(i) - f.x) / ratio.x, u.opt.x);
      var c = textureLoad(tex, clamp(vec2i(base) + vec2i(i, j), vec2i(0), maxc), 0).rgb;
      if (linear) { c = pow(max(c, vec3f(0.0)), vec3f(2.2)); }
      acc += c * w;
      wsum += w;
      if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
        lo = min(lo, c);
        hi = max(hi, c);
      }
    }
  }
  var col = acc / wsum;
  // Anti-ringing: pull overshoot back towards the local 2x2 range (upscaling only).
  let up = f32(ratio.x <= 1.0 && ratio.y <= 1.0);
  col = mix(col, clamp(col, lo, hi), u.opt.y * up);
  if (linear) { col = pow(max(col, vec3f(0.0)), vec3f(1.0 / 2.2)); }
  return vec4f(col, 1.0);
}
`;

/**
 * Edge-adaptive spatial upsampling in the style of AMD FidelityFX FSR 1.0 EASU
 * (algorithm by Timothy Lottes, MIT licensed): estimate edge direction/strength from a 12-tap
 * neighbourhood, then filter with a rotated, anisotropically stretched Lanczos-2 approximation and
 * clamp to the local 2x2 range.
 */
export const WGSL_EASU = /* wgsl */ `
${COMMON}
struct U { size: vec4f, opt: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

fn ld(p: vec2i) -> vec3f {
  return textureLoad(tex, clamp(p, vec2i(0), vec2i(u.size.xy) - 1), 0).rgb;
}
fn luma(c: vec3f) -> f32 { return c.b * 0.5 + (c.r * 0.5 + c.g); }

struct Acc { dir: vec2f, len: f32 };

fn easuSet(acc: Acc, w: f32, lA: f32, lB: f32, lC: f32, lD: f32, lE: f32) -> Acc {
  var r = acc;
  let dc = lD - lC;
  let cb = lC - lB;
  var lenX = max(abs(dc), abs(cb));
  lenX = 1.0 / max(lenX, 1e-6);
  let dirX = lD - lB;
  r.dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  r.len += lenX * lenX * w;
  let ec = lE - lC;
  let ca = lC - lA;
  var lenY = max(abs(ec), abs(ca));
  lenY = 1.0 / max(lenY, 1e-6);
  let dirY = lE - lA;
  r.dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  r.len += lenY * lenY * w;
  return r;
}

fn easuTap(off: vec2f, dir: vec2f, len: vec2f, lob: f32, clp: f32, c: vec3f) -> vec4f {
  var v = vec2f(off.x * dir.x + off.y * dir.y, off.x * (-dir.y) + off.y * dir.x);
  v *= len;
  let d2 = min(dot(v, v), clp);
  var wB = 0.4 * d2 - 1.0;
  var wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  let w = wB * wA;
  return vec4f(c * w, w);
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let src = u.size.xy;
  var pp = in.uv * src - 0.5;
  let fp = floor(pp);
  pp -= fp;
  let ip = vec2i(fp);
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  let bC = ld(ip + vec2i(0, -1)); let cC = ld(ip + vec2i(1, -1));
  let eC = ld(ip + vec2i(-1, 0)); let fC = ld(ip);                let gC = ld(ip + vec2i(1, 0)); let hC = ld(ip + vec2i(2, 0));
  let iC = ld(ip + vec2i(-1, 1)); let jC = ld(ip + vec2i(0, 1));  let kC = ld(ip + vec2i(1, 1)); let lC = ld(ip + vec2i(2, 1));
  let nC = ld(ip + vec2i(0, 2));  let oC = ld(ip + vec2i(1, 2));
  let bL = luma(bC); let cL = luma(cC); let eL = luma(eC); let fL = luma(fC); let gL = luma(gC); let hL = luma(hC);
  let iL = luma(iC); let jL = luma(jC); let kL = luma(kC); let lL = luma(lC); let nL = luma(nC); let oL = luma(oC);

  var acc = Acc(vec2f(0.0), 0.0);
  acc = easuSet(acc, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  acc = easuSet(acc, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  acc = easuSet(acc, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  acc = easuSet(acc, pp.x * pp.y, gL, jL, kL, lL, oL);

  var dir = acc.dir;
  var len = acc.len;
  let dirR = dot(dir, dir);
  let zro = dirR < (1.0 / 32768.0);
  let inv = select(inverseSqrt(max(dirR, 1e-12)), 1.0, zro);
  if (zro) { dir = vec2f(1.0, 0.0); }
  dir *= inv;
  len = len * 0.5;
  len *= len;
  let stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  let lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  let clp = 1.0 / lob;

  let mn = min(min(fC, gC), min(jC, kC));
  let mx = max(max(fC, gC), max(jC, kC));
  var a = vec4f(0.0);
  a += easuTap(vec2f(0.0, -1.0) - pp, dir, len2, lob, clp, bC);
  a += easuTap(vec2f(1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  a += easuTap(vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp, iC);
  a += easuTap(vec2f(0.0, 1.0) - pp, dir, len2, lob, clp, jC);
  a += easuTap(vec2f(0.0, 0.0) - pp, dir, len2, lob, clp, fC);
  a += easuTap(vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp, eC);
  a += easuTap(vec2f(1.0, 1.0) - pp, dir, len2, lob, clp, kC);
  a += easuTap(vec2f(2.0, 1.0) - pp, dir, len2, lob, clp, lC);
  a += easuTap(vec2f(2.0, 0.0) - pp, dir, len2, lob, clp, hC);
  a += easuTap(vec2f(1.0, 0.0) - pp, dir, len2, lob, clp, gC);
  a += easuTap(vec2f(1.0, 2.0) - pp, dir, len2, lob, clp, oC);
  a += easuTap(vec2f(0.0, 2.0) - pp, dir, len2, lob, clp, nC);
  return vec4f(min(mx, max(mn, a.rgb / a.w)), 1.0);
}
`;

export const WGSL_FINAL = /* wgsl */ `
${COMMON}
struct U { p: vec4f };   // sharpen (0..1), dither (0/1), frame counter, unused
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

fn ld(p: vec2i) -> vec3f {
  return textureLoad(tex, clamp(p, vec2i(0), vec2i(textureDimensions(tex)) - 1), 0).rgb;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  var col: vec3f;
  if (u.p.x > 0.0) {
    // Robust contrast-adaptive sharpening (FSR 1.0 RCAS style); input is 1:1 with the output.
    let ip = vec2i(in.pos.xy);
    let b = clamp(ld(ip + vec2i(0, -1)), vec3f(0.0), vec3f(1.0));
    let d = clamp(ld(ip + vec2i(-1, 0)), vec3f(0.0), vec3f(1.0));
    let e = clamp(ld(ip), vec3f(0.0), vec3f(1.0));
    let f = clamp(ld(ip + vec2i(1, 0)), vec3f(0.0), vec3f(1.0));
    let h = clamp(ld(ip + vec2i(0, 1)), vec3f(0.0), vec3f(1.0));
    let mn4 = min(min(b, d), min(f, h));
    let mx4 = max(max(b, d), max(f, h));
    let hitMin = min(mn4, e) / (4.0 * mx4 + 1e-5);
    let hitMax = (vec3f(1.0) - max(mx4, e)) / (4.0 * mn4 - 4.0 - 1e-5);
    let lobeRGB = max(-hitMin, hitMax);
    let lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * u.p.x;
    col = (lobe * (b + d + h + f) + e) / (4.0 * lobe + 1.0);
  } else {
    col = textureSampleLevel(tex, samp, in.uv, 0.0).rgb;
  }
  if (u.p.y > 0.5) {
    col += (hash12(in.pos.xy + fract(u.p.z * 0.754877) * 97.0) - 0.5) / 255.0;
  }
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;
