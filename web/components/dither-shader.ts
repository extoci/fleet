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

float pattern(vec2 p) {
  vec2 p2 = p - time * waveSpeed;
  return fbm(p + fbm(p2));
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
