// Dither field, shared with extoci.com (originally from the Dunce marketing site).
// Based on the React Bits Dither effect (MIT + Commons Clause); see licenses/react-bits-LICENSE.txt.
// Classic noise: Copyright (C) 2011 Ashima Arts and 2011-2016 Stefan Gustavson (MIT);
// see licenses/webgl-noise-MIT.txt.

export const vertexShader = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const noiseAndBayer = `
vec4 mod289(vec4 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec2 fade(vec2 t) { return t*t*t*(t*(t*6.0-15.0)+10.0); }

float cnoise(vec2 P) {
  vec4 Pi = floor(P.xyxy) + vec4(0.0,0.0,1.0,1.0);
  vec4 Pf = fract(P.xyxy) - vec4(0.0,0.0,1.0,1.0);
  Pi = mod289(Pi);
  vec4 ix = Pi.xzxz;
  vec4 iy = Pi.yyww;
  vec4 fx = Pf.xzxz;
  vec4 fy = Pf.yyww;
  vec4 i = permute(permute(ix) + iy);
  vec4 gx = fract(i * (1.0/41.0)) * 2.0 - 1.0;
  vec4 gy = abs(gx) - 0.5;
  vec4 tx = floor(gx + 0.5);
  gx = gx - tx;
  vec2 g00 = vec2(gx.x, gy.x);
  vec2 g10 = vec2(gx.y, gy.y);
  vec2 g01 = vec2(gx.z, gy.z);
  vec2 g11 = vec2(gx.w, gy.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g00,g00), dot(g01,g01), dot(g10,g10), dot(g11,g11)));
  g00 *= norm.x; g01 *= norm.y; g10 *= norm.z; g11 *= norm.w;
  float n00 = dot(g00, vec2(fx.x, fy.x));
  float n10 = dot(g10, vec2(fx.y, fy.y));
  float n01 = dot(g01, vec2(fx.z, fy.z));
  float n11 = dot(g11, vec2(fx.w, fy.w));
  vec2 fade_xy = fade(Pf.xy);
  vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), fade_xy.x);
  return 2.3 * mix(n_x.x, n_x.y, fade_xy.y);
}

const int OCTAVES = 4;
float fbm(vec2 p) {
  float value = 0.0;
  float amp = 1.0;
  float freq = waveFrequency;
  for (int i = 0; i < OCTAVES; i++) {
    value += amp * abs(cnoise(p));
    p *= freq;
    amp *= waveAmplitude;
  }
  return value;
}

float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x / 2.0 + a.y * a.y * 0.75);
}

float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}

float bayer8(vec2 a) {
  return bayer4(0.5 * a) * 0.25 + bayer2(a);
}
`

export const fragmentShader = `
precision highp float;

uniform vec2 resolution;
uniform float time;
uniform float waveSpeed;
uniform float waveFrequency;
uniform float waveAmplitude;
uniform vec3 waveColor;
uniform vec3 shadowColor;
uniform vec3 highlightColor;
uniform float gain;
uniform vec2 mousePos;
uniform float mouseRadius;
uniform vec2 focus;
uniform vec2 spread;
uniform float colorNum;
uniform float pixelSize;
uniform float seed;

const float PATTERN_CELLS = 300.0;
${noiseAndBayer}
float pattern(vec2 p) {
  vec2 p2 = p - time * waveSpeed;
  return fbm(p + fbm(p2));
}

// Quantise brightness, then colour it, so every cell stays on the palette.
float ditherLevel(vec2 uv, float value) {
  vec2 cell = floor(uv * resolution / pixelSize);
  float threshold = bayer8(mod(cell, 8.0)) / 1.25 - 0.25;
  float steps = colorNum - 1.0;
  value = clamp(value + threshold / steps - 0.2, 0.0, 1.0);
  return floor(value * steps + 0.5) / steps;
}

void main() {
  vec2 st = gl_FragCoord.xy / resolution.xy;
  // Sample the noise in cells, so the pattern keeps its size whatever the canvas measures.
  vec2 uv = (gl_FragCoord.xy - 0.5 * resolution.xy) / PATTERN_CELLS;
  uv += vec2(seed, seed * 0.61);
  float f = pattern(uv) * gain;

  // Thin the field out away from the focus so the dither itself fades, not an overlay.
  float reach = 1.0 - smoothstep(0.35, 1.0, length((st - focus) * 2.0 / spread));
  f *= reach;

  vec2 toMouse = (st - mousePos) * resolution.xy / PATTERN_CELLS;
  f += 0.3 * (1.0 - smoothstep(0.0, mouseRadius, length(toMouse))) * (0.3 + reach);

  float level = ditherLevel(st, f);
  vec3 color = mix(shadowColor, waveColor, smoothstep(0.0, 0.75, level));
  color = mix(color, highlightColor, smoothstep(0.75, 1.0, level));
  float alpha = step(0.001, level);
  gl_FragColor = vec4(color * alpha, alpha);
}
`

export const plumbobFragmentShader = `
precision highp float;

uniform vec2 resolution;
uniform float time;
uniform float waveFrequency;
uniform float waveAmplitude;
uniform float spinAngle;
uniform float bobOffset;
uniform float auraStrength;
uniform float zoom;
uniform vec2 mousePos;
uniform float mouseActive;
uniform vec3 shadowColor;
uniform vec3 deepColor;
uniform vec3 waveColor;
uniform vec3 highlightColor;
${noiseAndBayer}
float pattern(vec2 p) {
  vec2 p2 = p - vec2(time * 0.14, time * 0.22);
  return fbm(p + fbm(p2));
}

float ditherQuantize(vec2 cell, float value, float levels) {
  float threshold = bayer8(mod(cell, 8.0)) / 1.25 - 0.25;
  float steps = levels - 1.0;
  float v = clamp(value + threshold / steps - 0.12, 0.0, 1.0);
  return floor(v * steps + 0.5) / steps;
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

vec3 paletteColor(float level) {
  vec3 obsidian = shadowColor * 0.55;
  if (level < 0.25) return mix(obsidian, shadowColor, level * 4.0);
  if (level < 0.50) return mix(shadowColor, deepColor, (level - 0.25) * 4.0);
  if (level < 0.75) return mix(deepColor, waveColor, (level - 0.50) * 4.0);
  return mix(waveColor, highlightColor, (level - 0.75) * 4.0);
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 st = gl_FragCoord.xy / resolution.xy;
  vec2 p = (gl_FragCoord.xy - 0.5 * resolution.xy) / min(resolution.x, resolution.y) * 2.0;
  vec2 pb = p - vec2(0.0, bobOffset);

  vec3 ro = vec3(0.0, 0.0, 2.95);
  vec3 rd = normalize(vec3(pb * zoom, -2.25));

  float tiltX = 0.13;
  ro.yz = rot(tiltX) * ro.yz;
  rd.yz = rot(tiltX) * rd.yz;
  ro.xz = rot(spinAngle) * ro.xz;
  rd.xz = rot(spinAngle) * rd.xz;

  const float H = 1.00;
  const float R = 0.54;
  const float rIn = R * 0.8660254;
  float dPlane = 1.0 / length(vec2(1.0 / rIn, 1.0 / H));

  float tNear = -1e5;
  float tFar = 1e5;
  vec3 hitNormal = vec3(0.0);
  int hitFace = -1;

  for (int i = 0; i < 6; i++) {
    float phi = (float(i) + 0.5) * 1.04719755;
    vec2 h = vec2(cos(phi), sin(phi));

    vec3 nUp = normalize(vec3(h.x / rIn, 1.0 / H, h.y / rIn));
    float denomU = dot(rd, nUp);
    float numU = dPlane - dot(ro, nUp);
    if (abs(denomU) < 1e-6) {
      if (numU < 0.0) { tNear = 1e5; tFar = -1e5; }
    } else {
      float t = numU / denomU;
      if (denomU < 0.0) {
        if (t > tNear) { tNear = t; hitNormal = nUp; hitFace = i; }
      } else {
        tFar = min(tFar, t);
      }
    }

    vec3 nDn = normalize(vec3(h.x / rIn, -1.0 / H, h.y / rIn));
    float denomD = dot(rd, nDn);
    float numD = dPlane - dot(ro, nDn);
    if (abs(denomD) < 1e-6) {
      if (numD < 0.0) { tNear = 1e5; tFar = -1e5; }
    } else {
      float t = numD / denomD;
      if (denomD < 0.0) {
        if (t > tNear) { tNear = t; hitNormal = nDn; hitFace = i + 6; }
      } else {
        tFar = min(tFar, t);
      }
    }
  }

  vec2 waveUv = pb * 1.05 + vec2(0.4, 0.25);
  float wave = pattern(waveUv);

  float mBoost = 0.0;
  if (mouseActive > 0.5) {
    vec2 mVec = st - mousePos;
    mVec.x *= resolution.x / resolution.y;
    mBoost = 0.34 * (1.0 - smoothstep(0.0, 0.38, length(mVec)));
  }

  if (tNear <= tFar && tFar > 0.0) {
    vec3 hitPos = ro + tNear * rd;
    float minMargin = 1e5;
    for (int i = 0; i < 6; i++) {
      float phi = (float(i) + 0.5) * 1.04719755;
      vec2 h = vec2(cos(phi), sin(phi));
      vec3 nUp = normalize(vec3(h.x / rIn, 1.0 / H, h.y / rIn));
      vec3 nDn = normalize(vec3(h.x / rIn, -1.0 / H, h.y / rIn));
      if (i != hitFace) minMargin = min(minMargin, dPlane - dot(hitPos, nUp));
      if (i + 6 != hitFace) minMargin = min(minMargin, dPlane - dot(hitPos, nDn));
    }
    float ridge = 1.0 - smoothstep(0.0, 0.036, max(0.0, minMargin));

    vec3 L1 = normalize(vec3(-0.55, 0.62, 0.62));
    vec3 L2 = normalize(vec3(0.68, -0.28, 0.48));
    L1.yz = rot(tiltX) * L1.yz; L1.xz = rot(spinAngle) * L1.xz;
    L2.yz = rot(tiltX) * L2.yz; L2.xz = rot(spinAngle) * L2.xz;
    vec3 V = -rd;

    float diff1 = max(0.0, dot(hitNormal, L1));
    float diff2 = max(0.0, dot(hitNormal, L2));
    vec3 H1 = normalize(L1 + V);
    float spec = pow(max(0.0, dot(hitNormal, H1)), 22.0);
    float upHalf = smoothstep(-0.22, 0.22, hitNormal.y);
    float core = exp(-length(hitPos.xy * vec2(1.4, 0.72)) * 1.9) * 0.14;

    float facetLit = 0.20 + 0.36 * diff1 + 0.15 * upHalf + 0.12 * diff2 + 0.18 * spec + core;
    facetLit += ridge * (0.14 + 0.28 * diff1);

    float field = clamp(facetLit + (wave - 0.56) * 0.36 + mBoost * 0.65, 0.12, 0.98);
    float level = ditherQuantize(cell, field, 5.0);
    gl_FragColor = vec4(paletteColor(level), 1.0);
    return;
  }

  if (auraStrength > 0.01) {
    float diamondDist = abs(pb.x) / 0.58 + abs(pb.y) / 1.02 - 1.0;
    float gap = smoothstep(0.02, 0.12, diamondDist);
    float reach = (1.0 - smoothstep(0.05, 0.55, max(0.0, diamondDist))) * gap;
    float f = (wave * 0.52 + 0.04) * reach * auraStrength + mBoost * reach * 1.05;

    float threshold = bayer8(mod(cell, 8.0)) / 1.25 - 0.25;
    float steps = 4.0;
    float v = clamp(f + threshold / steps - 0.26, 0.0, 1.0);
    float level = floor(v * steps + 0.5) / steps;
    float alpha = step(0.001, level);

    vec3 col = mix(shadowColor, waveColor, smoothstep(0.0, 0.85, level));
    gl_FragColor = vec4(col * alpha, alpha);
    return;
  }

  gl_FragColor = vec4(0.0);
}
`
