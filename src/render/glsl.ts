/**
 * GLSL ES 3.00 ports of the WGSL passes (see wgsl.ts for commentary).
 * Texture space here follows GL conventions (v = 0 is the bottom row of an FBO); only the ingest
 * passes flip, because uploaded images have their first row at v = 0.
 */

export const GLSL_VERT = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;

vec2 rotUv(vec2 uv, int rot) {
  if (rot == 1) return vec2(uv.y, 1.0 - uv.x);
  if (rot == 2) return vec2(1.0 - uv.x, 1.0 - uv.y);
  if (rot == 3) return vec2(1.0 - uv.y, uv.x);
  return uv;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Colour management shared by both ingest passes (see COLOR in wgsl.ts). */
const COLOR = /* glsl */ `
const float PQ_M1 = 0.1593017578125;
const float PQ_M2 = 78.84375;
const float PQ_C1 = 0.8359375;
const float PQ_C2 = 18.8515625;
const float PQ_C3 = 18.6875;
const float SDR_WHITE = 203.0;

vec3 pqEotf(vec3 e) {
  vec3 p = pow(max(e, vec3(0.0)), vec3(1.0 / PQ_M2));
  return pow(max(p - PQ_C1, vec3(0.0)) / (PQ_C2 - PQ_C3 * p), vec3(1.0 / PQ_M1));
}
float pqOetf1(float y) {
  float p = pow(max(y, 0.0), PQ_M1);
  return pow((PQ_C1 + PQ_C2 * p) / (1.0 + PQ_C3 * p), PQ_M2);
}
float pqEotf1(float e) {
  float p = pow(max(e, 0.0), 1.0 / PQ_M2);
  return pow(max(p - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * p), 1.0 / PQ_M1);
}
vec3 hlgToDisplay(vec3 e) {
  const float a = 0.17883277;
  const float b = 0.28466892;
  const float c = 0.55991073;
  vec3 lo = e * e / 3.0;
  vec3 hi = (exp((e - c) / a) + b) / 12.0;
  vec3 scene = mix(hi, lo, vec3(lessThanEqual(e, vec3(0.5))));
  float ys = dot(scene, vec3(0.2627, 0.6780, 0.0593));
  return scene * pow(max(ys, 1e-6), 0.2);
}
float hable(float x) {
  const float A = 0.15; const float B = 0.50; const float C = 0.10;
  const float D = 0.20; const float E = 0.02; const float F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
float toneCurve(float x, float peak, int kind) {
  if (kind == 3) return min(x, 1.0);
  if (kind == 2) return x * (1.0 + x / (peak * peak)) / (1.0 + x);
  if (kind == 1) return hable(x) / hable(peak);
  float srcPq = pqOetf1(peak * SDR_WHITE / 10000.0);
  float dstPq = pqOetf1(SDR_WHITE / 10000.0);
  float e1 = pqOetf1(x * SDR_WHITE / 10000.0) / srcPq;
  float maxLum = dstPq / srcPq;
  float ks = 1.5 * maxLum - 0.5;
  float e2 = e1;
  if (e1 > ks) {
    float t = (e1 - ks) / (1.0 - ks);
    float t2 = t * t;
    float t3 = t2 * t;
    e2 = (2.0 * t3 - 3.0 * t2 + 1.0) * ks + (t3 - 2.0 * t2 + t) * (1.0 - ks) + (-2.0 * t3 + 3.0 * t2) * maxLum;
  }
  return pqEotf1(e2 * srcPq) * 10000.0 / SDR_WHITE;
}
vec3 srgbEotfSigned(vec3 v) {
  vec3 a = abs(v);
  return sign(v) * mix(pow((a + 0.055) / 1.055, vec3(2.4)), a / 12.92, vec3(lessThanEqual(a, vec3(0.04045))));
}

const float GAMUT_KNEE = 0.95;
vec3 gamutCompress(vec3 c, vec3 src) {
  float a = max(c.r, max(c.g, c.b));
  if (a <= 1e-6) return vec3(0.0);
  float s = (a - min(c.r, min(c.g, c.b))) / a;
  vec3 o = c;
  if (s > GAMUT_KNEE) {
    float own = (a - min(src.r, min(src.g, src.b))) / a;
    float lim = max(s / max(own, 1e-4), 1.0001);
    float k = (lim - GAMUT_KNEE) / pow(pow((1.0 - GAMUT_KNEE) / (lim - GAMUT_KNEE), -1.2) - 1.0, 1.0 / 1.2);
    float nd = (s - GAMUT_KNEE) / k;
    float s2 = GAMUT_KNEE + k * nd / pow(1.0 + pow(nd, 1.2), 1.0 / 1.2);
    o = vec3(a) + (c - vec3(a)) * (s2 / s);
  }
  if (a > 1.0) {
    float y = dot(o, vec3(0.2126, 0.7152, 0.0722));
    o = mix(o, vec3(y), clamp((a - 1.0) / max(a - y, 1e-6), 0.0, 1.0));
  }
  return o;
}

// transfer: 0 sdr, 1 pq, 2 hlg.  primaries: 0 709, 1 2020, 2 p3.  tone: curve.  gamut: 0 clip, 1 soft.
vec3 colorManage(vec3 coded, int transfer, int primaries, int tone, int gamut, float peakNits) {
  vec3 lin;
  if (transfer == 1) lin = pqEotf(clamp(coded, 0.0, 1.0)) * (10000.0 / SDR_WHITE);
  else if (transfer == 2) lin = hlgToDisplay(clamp(coded, 0.0, 1.0)) * (1000.0 / SDR_WHITE);
  else lin = pow(max(coded, vec3(0.0)), vec3(2.4));
  if (transfer != 0) {
    float peak = max(peakNits / SDR_WHITE, 1.0);
    float m = max(max(lin.r, lin.g), max(lin.b, 1e-6));
    lin *= toneCurve(min(m, peak), peak, tone) / m;
  }
  vec3 src = lin;
  if (primaries == 1) {
    lin = vec3(dot(vec3(1.660491, -0.587641, -0.072850), src),
               dot(vec3(-0.124550, 1.132900, -0.008349), src),
               dot(vec3(-0.018151, -0.100579, 1.118730), src));
  } else if (primaries == 2) {
    lin = vec3(dot(vec3(1.224940, -0.224940, 0.0), src),
               dot(vec3(-0.042057, 1.042057, 0.0), src),
               dot(vec3(-0.019638, -0.078636, 1.098274), src));
  }
  if (gamut == 1 && primaries != 0) lin = gamutCompress(lin, src);
  return pow(clamp(lin, 0.0, 1.0), vec3(1.0 / 2.4));
}
`;

export const GLSL_INGEST_EXTERNAL = /* glsl */ `${HEAD}
${COLOR}
uniform sampler2D uTex;
uniform ivec4 uMode;   // packing (0 converted by the browser, 1 coded, 2 coded behind matrix + sRGB OETF), transfer, primaries, rotation
uniform ivec2 uOpt;    // tone map, gamut mapping
uniform float uPeak;
void main() {
  vec2 uv = rotUv(vec2(vUv.x, 1.0 - vUv.y), uMode.w);
  vec3 c = texture(uTex, uv).rgb;
  if (uMode.x != 0) {
    vec3 coded = c;
    if (uMode.x == 2) {
      vec3 v = srgbEotfSigned(c);
      if (uMode.z == 1) {
        coded = vec3(dot(vec3(0.627404, 0.329283, 0.043313), v),
                     dot(vec3(0.069097, 0.919540, 0.011362), v),
                     dot(vec3(0.016391, 0.088013, 0.895595), v));
      } else if (uMode.z == 2) {
        coded = vec3(dot(vec3(0.822462, 0.177538, 0.0), v),
                     dot(vec3(0.033194, 0.966806, 0.0), v),
                     dot(vec3(0.017083, 0.072397, 0.910520), v));
      } else {
        coded = v;
      }
    }
    c = colorManage(coded, uMode.y, uMode.z, uOpt.x, uOpt.y, uPeak);
  }
  outColor = vec4(c, 1.0);
}`;

/** Reads tiles of the uploaded external texture 1:1 for the hand-over check (see WGSL_PROBE_EXTERNAL). */
export const GLSL_PROBE_EXTERNAL = /* glsl */ `${HEAD}
uniform sampler2D uTex;
uniform vec4 uOx;      // left edge of each tile column
uniform vec4 uOy;      // top edge of each tile row
uniform int uTile;     // tile size
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 tile = p / uTile;
  ivec2 src = ivec2(int(uOx[tile.x]), int(uOy[tile.y])) + (p - tile * uTile);
  outColor = vec4(texelFetch(uTex, src, 0).rgb, 1.0);
}`;

export const GLSL_INGEST_PLANAR = /* glsl */ `${HEAD}
${COLOR}
uniform sampler2D uTexY;
uniform sampler2D uTexU;
uniform sampler2D uTexV;
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec3 uM2;
uniform vec3 uOff;
uniform vec3 uScl;
uniform vec2 uPack;
uniform float uPeak;
uniform ivec4 uMode;   // transfer, primaries, tone map, rotation
uniform int uGamut;    // 0 clip, 1 soft

void main() {
  vec2 uv = rotUv(vec2(vUv.x, 1.0 - vUv.y), uMode.w);
  float y = dot(texture(uTexY, uv).rg, uPack);
  float cb = dot(texture(uTexU, uv).rg, uPack);
  float cr = dot(texture(uTexV, uv).rg, uPack);
  vec3 yuv = (vec3(y, cb, cr) - uOff) * uScl;
  vec3 rgb = vec3(dot(uM0, yuv), dot(uM1, yuv), dot(uM2, yuv));
  if (uMode.x != 0 || uMode.y != 0) rgb = colorManage(rgb, uMode.x, uMode.y, uMode.z, uGamut, uPeak);
  outColor = vec4(rgb, 1.0);
}`;

export const GLSL_DEBAND = /* glsl */ `${HEAD}
uniform sampler2D uTex;
uniform vec4 uP;   // threshold, range, grain, frame
void main() {
  vec2 pt = 1.0 / vec2(textureSize(uTex, 0));
  vec3 col = texture(uTex, vUv).rgb;
  vec2 seed = gl_FragCoord.xy + fract(uP.w * 0.6180339887) * 289.0;
  for (int i = 1; i <= 2; i++) {
    float fi = float(i);
    float dist = hash12(seed + fi * 17.13) * uP.y * fi;
    float ang = hash12(seed.yx + fi * 71.37) * 6.2831853;
    vec2 o = vec2(cos(ang), sin(ang)) * dist * pt;
    vec3 avg = 0.25 * (texture(uTex, vUv + o).rgb + texture(uTex, vUv - o).rgb +
                       texture(uTex, vUv + vec2(-o.y, o.x)).rgb + texture(uTex, vUv + vec2(o.y, -o.x)).rgb);
    vec3 diff = abs(col - avg);
    col = mix(avg, col, step(vec3(uP.x / fi), diff));
  }
  vec3 g = vec3(hash12(seed * 1.31), hash12(seed * 1.73 + 5.0), hash12(seed * 2.11 + 11.0)) - 0.5;
  outColor = vec4(col + g * uP.z, 1.0);
}`;

export const GLSL_SCALE = /* glsl */ `${HEAD}
uniform sampler2D uTex;
uniform vec4 uSize;   // src w,h, dst w,h
uniform vec4 uOpt;    // kernel, anti-ring, linear, unused

float kern(float x, float k) {
  float ax = abs(x);
  if (k < 1.5) {
    if (ax < 1.0) return (1.5 * ax - 2.5) * ax * ax + 1.0;
    if (ax < 2.0) return ((-0.5 * ax + 2.5) * ax - 4.0) * ax + 2.0;
    return 0.0;
  }
  if (ax < 1e-5) return 1.0;
  if (ax >= 3.0) return 0.0;
  float px = 3.14159265 * ax;
  return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
}

void main() {
  if (uOpt.x < 0.5) { outColor = vec4(texture(uTex, vUv).rgb, 1.0); return; }
  vec2 src = uSize.xy;
  vec2 dst = uSize.zw;
  vec2 ratio = max(src / dst, vec2(1.0));
  float support = uOpt.x > 1.5 ? 3.0 : 2.0;
  vec2 p = vUv * src - 0.5;
  vec2 base = floor(p);
  vec2 f = p - base;
  ivec2 rad = ivec2(min(ceil(support * ratio), vec2(8.0)));
  ivec2 maxc = ivec2(src) - 1;
  bool lin = uOpt.z > 0.5;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  vec3 lo = vec3(1e9);
  vec3 hi = vec3(-1e9);
  for (int j = 1 - rad.y; j <= rad.y; j++) {
    float wy = kern((float(j) - f.y) / ratio.y, uOpt.x);
    for (int i = 1 - rad.x; i <= rad.x; i++) {
      float w = wy * kern((float(i) - f.x) / ratio.x, uOpt.x);
      vec3 c = texelFetch(uTex, clamp(ivec2(base) + ivec2(i, j), ivec2(0), maxc), 0).rgb;
      if (lin) c = pow(max(c, vec3(0.0)), vec3(2.2));
      acc += c * w;
      wsum += w;
      if (i >= 0 && i <= 1 && j >= 0 && j <= 1) { lo = min(lo, c); hi = max(hi, c); }
    }
  }
  vec3 col = acc / wsum;
  float up = (ratio.x <= 1.0 && ratio.y <= 1.0) ? 1.0 : 0.0;
  col = mix(col, clamp(col, lo, hi), uOpt.y * up);
  if (lin) col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}`;

export const GLSL_EASU = /* glsl */ `${HEAD}
uniform sampler2D uTex;
uniform vec4 uSize;

vec3 ld(ivec2 p) { return texelFetch(uTex, clamp(p, ivec2(0), ivec2(uSize.xy) - 1), 0).rgb; }
float luma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

void easuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = 1.0 / max(max(abs(dc), abs(cb)), 1e-6);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  len += lenX * lenX * w;
  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = 1.0 / max(max(abs(ec), abs(ca)), 1e-6);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  len += lenY * lenY * w;
}

vec4 easuTap(vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * (-dir.y) + off.y * dir.x);
  v *= len;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  return vec4(c * w, w);
}

void main() {
  vec2 pp = vUv * uSize.xy - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  ivec2 ip = ivec2(fp);
  vec3 bC = ld(ip + ivec2(0, -1)); vec3 cC = ld(ip + ivec2(1, -1));
  vec3 eC = ld(ip + ivec2(-1, 0)); vec3 fC = ld(ip);               vec3 gC = ld(ip + ivec2(1, 0)); vec3 hC = ld(ip + ivec2(2, 0));
  vec3 iC = ld(ip + ivec2(-1, 1)); vec3 jC = ld(ip + ivec2(0, 1)); vec3 kC = ld(ip + ivec2(1, 1)); vec3 lC = ld(ip + ivec2(2, 1));
  vec3 nC = ld(ip + ivec2(0, 2));  vec3 oC = ld(ip + ivec2(1, 2));
  float bL = luma(bC), cL = luma(cC), eL = luma(eC), fL = luma(fC), gL = luma(gC), hL = luma(hC);
  float iL = luma(iC), jL = luma(jC), kL = luma(kC), lL = luma(lC), nL = luma(nC), oL = luma(oC);
  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);
  float dirR = dot(dir, dir);
  bool zro = dirR < (1.0 / 32768.0);
  float inv = zro ? 1.0 : inversesqrt(max(dirR, 1e-12));
  if (zro) dir = vec2(1.0, 0.0);
  dir *= inv;
  len = len * 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;
  vec3 mn = min(min(fC, gC), min(jC, kC));
  vec3 mx = max(max(fC, gC), max(jC, kC));
  vec4 a = vec4(0.0);
  a += easuTap(vec2(0.0, -1.0) - pp, dir, len2, lob, clp, bC);
  a += easuTap(vec2(1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  a += easuTap(vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, iC);
  a += easuTap(vec2(0.0, 1.0) - pp, dir, len2, lob, clp, jC);
  a += easuTap(vec2(0.0, 0.0) - pp, dir, len2, lob, clp, fC);
  a += easuTap(vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, eC);
  a += easuTap(vec2(1.0, 1.0) - pp, dir, len2, lob, clp, kC);
  a += easuTap(vec2(2.0, 1.0) - pp, dir, len2, lob, clp, lC);
  a += easuTap(vec2(2.0, 0.0) - pp, dir, len2, lob, clp, hC);
  a += easuTap(vec2(1.0, 0.0) - pp, dir, len2, lob, clp, gC);
  a += easuTap(vec2(1.0, 2.0) - pp, dir, len2, lob, clp, oC);
  a += easuTap(vec2(0.0, 2.0) - pp, dir, len2, lob, clp, nC);
  outColor = vec4(min(mx, max(mn, a.rgb / a.w)), 1.0);
}`;

export const GLSL_FINAL = /* glsl */ `${HEAD}
uniform sampler2D uTex;
uniform vec4 uP;   // sharpen, dither, frame, unused

vec3 ld(ivec2 p) {
  return clamp(texelFetch(uTex, clamp(p, ivec2(0), textureSize(uTex, 0) - 1), 0).rgb, 0.0, 1.0);
}

void main() {
  vec3 col;
  if (uP.x > 0.0) {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    vec3 b = ld(ip + ivec2(0, -1));
    vec3 d = ld(ip + ivec2(-1, 0));
    vec3 e = ld(ip);
    vec3 f = ld(ip + ivec2(1, 0));
    vec3 h = ld(ip + ivec2(0, 1));
    vec3 mn4 = min(min(b, d), min(f, h));
    vec3 mx4 = max(max(b, d), max(f, h));
    vec3 hitMin = min(mn4, e) / (4.0 * mx4 + 1e-5);
    vec3 hitMax = (vec3(1.0) - max(mx4, e)) / (4.0 * mn4 - 4.0 - 1e-5);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-0.1875, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * uP.x;
    col = (lobe * (b + d + h + f) + e) / (4.0 * lobe + 1.0);
  } else {
    col = texture(uTex, vUv).rgb;
  }
  if (uP.y > 0.5) col += (hash12(gl_FragCoord.xy + fract(uP.z * 0.754877) * 97.0) - 0.5) / 255.0;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
