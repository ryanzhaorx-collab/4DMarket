/** 引擎使用的全部 GLSL ES 3.00 着色器。 */

export const SPLAT_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;

layout(location = 0) in vec2 aCorner;

uniform mat4 uView;
uniform mat4 uProj;
uniform vec2 uViewport;
uniform float uFocal;
uniform float uMaxRadius;
uniform float uAlphaMul;
uniform int uTexW;
uniform int uIdxStride;
uniform float uResolve;   // 0..1 入场：点云粉尘聚合成实体
uniform float uScatter;   // 粉尘初始散开半径（世界单位）
uniform vec4 uSlice;      // x:y0  y:y1  z:平移距离  w:其余部分透明度
uniform vec4 uSliceBox;   // x0, x1, z0, z1 —— 盒子在 XZ 上的范围
uniform vec3 uSliceDir;   // 平移方向（世界坐标，单位向量）
uniform float uSliceT;    // 0..1 抽屉进度
uniform vec3 uSplit;      // x:上半上移  y:下半下移  z:进度 0..1

uniform sampler2D uPos;    // xyz + opacity
uniform sampler2D uScale;  // xyz (米)
uniform sampler2D uRot;    // xyzw 单位四元数
uniform sampler2D uCol;    // rgb
uniform usampler2D uIdx;   // 由远及近的索引

out vec2 vPos;
out vec3 vConic;
out vec4 vColor;
out float vAlpha;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

mat3 quatToMat3(vec4 q) {
  float x = q.x, y = q.y, z = q.z, w = q.w;
  float xx = x * x, yy = y * y, zz = z * z;
  float xy = x * y, xz = x * z, yz = y * z;
  float wx = w * x, wy = w * y, wz = w * z;
  return mat3(
    1.0 - 2.0 * (yy + zz), 2.0 * (xy + wz), 2.0 * (xz - wy),
    2.0 * (xy - wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz + wx),
    2.0 * (xz + wy), 2.0 * (yz - wx), 1.0 - 2.0 * (xx + yy)
  );
}

void main() {
  int slot = gl_InstanceID * uIdxStride;
  ivec2 ic = ivec2(slot % uTexW, slot / uTexW);
  uint gi = texelFetch(uIdx, ic, 0).r;
  ivec2 tc = ivec2(int(gi) % uTexW, int(gi) / uTexW);

  vec4 sp = texelFetch(uPos, tc, 0);
  vec3 sc = texelFetch(uScale, tc, 0).xyz;
  vec4 q = texelFetch(uRot, tc, 0);
  vec4 col = texelFetch(uCol, tc, 0);

  // 入场动画：每个点按自身随机相位「凝聚」，同时从散开位置回收、尺寸由小变大
  vec3 world = sp.xyz;
  vec3 scl = sc;
  float appearMul = 1.0;
  if (uResolve < 0.999) {
    float h1 = hash11(float(gi));
    float appear = smoothstep(h1 * 0.55, h1 * 0.55 + 0.45, uResolve);
    vec3 dir = vec3(
      hash11(float(gi) + 71.0),
      hash11(float(gi) + 131.0),
      hash11(float(gi) + 197.0)
    ) - 0.5;
    dir = length(dir) > 0.001 ? normalize(dir) : vec3(0.0, 1.0, 0.0);
    world += dir * uScatter * (1.0 - appear);
    scl *= mix(0.22, 1.0, appear);
    appearMul = appear;
  }

  // 楼体整体上下分开：上半上移、下半下沉，中间露出这一层
  if (uSplit.z > 0.001) {
    float above = smoothstep(uSlice.y - 1.0, uSlice.y + 1.0, sp.y);
    float below = 1.0 - smoothstep(uSlice.x - 1.0, uSlice.x + 1.0, sp.y);
    world.y += above * uSplit.x * uSplit.z;
    world.y -= below * uSplit.y * uSplit.z;
    // 被抽走的那一层本身要消隐，否则它会像桥一样把裂缝填住
    float bandFade = (1.0 - above) * (1.0 - below);
    appearMul *= 1.0 - bandFade * uSplit.z;
  }

  // 伪分层：把 [y0, y1] 这一层「抽」出来，其余部分压暗。
  if (uSliceT > 0.001) {
    float band =
      smoothstep(uSlice.x - 0.8, uSlice.x + 0.8, sp.y) *
      (1.0 - smoothstep(uSlice.y - 0.8, uSlice.y + 0.8, sp.y));
    band *=
      smoothstep(uSliceBox.x - 0.8, uSliceBox.x + 0.8, sp.x) *
      (1.0 - smoothstep(uSliceBox.y - 0.8, uSliceBox.y + 0.8, sp.x)) *
      smoothstep(uSliceBox.z - 0.8, uSliceBox.z + 0.8, sp.z) *
      (1.0 - smoothstep(uSliceBox.w - 0.8, uSliceBox.w + 0.8, sp.z));
    world += uSliceDir * (uSlice.z * uSliceT * band);
    appearMul *= mix(mix(1.0, uSlice.w, uSliceT), 1.0, band);
  }

  vec4 vp = uView * vec4(world, 1.0);
  vAlpha = sp.w * uAlphaMul * appearMul;
  vColor = col;

  // 相机背后 / 过近：裁掉（clip 空间 w 必须为正）
  if (vp.z > -0.02 || vAlpha < 0.003) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vPos = vec2(0.0);
    vConic = vec3(1.0, 0.0, 1.0);
    return;
  }

  float f = uFocal;
  float iz = 1.0 / vp.z;
  mat3 J = mat3(
    f * iz, 0.0, 0.0,
    0.0, f * iz, 0.0,
    -f * vp.x * iz * iz, -f * vp.y * iz * iz, 0.0
  );
  mat3 R = quatToMat3(q);
  mat3 M = mat3(R[0] * scl.x, R[1] * scl.y, R[2] * scl.z);
  mat3 S = M * transpose(M);
  mat3 T = J * mat3(uView);
  mat3 cov = T * S * transpose(T);

  float a = cov[0][0] + 0.3;
  float b = cov[0][1];
  float c = cov[1][1] + 0.3;
  float det = a * c - b * b;
  if (det <= 1e-9) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vPos = vec2(0.0);
    vConic = vec3(1.0, 0.0, 1.0);
    return;
  }

  float mid = 0.5 * (a + c);
  float disc = sqrt(max(0.25 * (a - c) * (a - c) + b * b, 0.0));
  float lambda = mid + disc;
  float radius = clamp(3.0 * sqrt(max(lambda, 0.0)), 0.7, uMaxRadius);

  vec4 clip = uProj * vp;
  vec2 halfPx = uViewport * 0.5;
  clip.xy += aCorner * (radius / halfPx) * clip.w;
  gl_Position = clip;

  vPos = aCorner * radius;
  vConic = vec3(c, -b, a) / det;
}
`;

export const SPLAT_FS = /* glsl */ `#version 300 es
precision highp float;

in vec2 vPos;
in vec3 vConic;
in vec4 vColor;
in float vAlpha;

out vec4 fragColor;

void main() {
  float power = -0.5 * (vConic.x * vPos.x * vPos.x
              + 2.0 * vConic.y * vPos.x * vPos.y
              + vConic.z * vPos.y * vPos.y);
  if (power > 0.0) discard;
  float alpha = min(0.995, vAlpha * exp(power));
  if (alpha < 0.004) discard;
  // 预乘 alpha，配合 ONE / ONE_MINUS_SRC_ALPHA
  fragColor = vec4(vColor.rgb * alpha, alpha);
}
`;

export const SKY_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const SKY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlow;
out vec4 fragColor;
void main() {
  float t = clamp(vUv.y, 0.0, 1.0);
  vec3 col = mix(uBottom, uTop, pow(t, 0.85));
  // 右下角一点暖金反光，呼应「墨金」主题
  vec2 glowPos = vec2(0.82, 0.12);
  float g = exp(-length((vUv - glowPos) * vec2(1.6, 2.2)) * 3.2);
  col += uGlow * g * 0.35;
  fragColor = vec4(col, 1.0);
}
`;

export const TILE_VS = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aUV;

uniform mat4 uModel;
uniform mat4 uViewProj;

out vec3 vNormal;
out vec4 vColor;
out vec2 vUV;
out vec3 vWorld;
out float vLocalY;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vLocalY = aPos.y;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vUV = aUV;
  gl_Position = uViewProj * world;
}
`;

export const TILE_FS = /* glsl */ `#version 300 es
precision highp float;

in vec3 vNormal;
in vec4 vColor;
in vec2 vUV;
in vec3 vWorld;
in float vLocalY;

uniform sampler2D uTex;
uniform float uUseTex;
uniform float uReveal;    // 0..1 自下而上显形
uniform float uRevealH;   // 楼层高度（米）
uniform vec3 uBaseColor;
uniform float uAlphaMul;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;

out vec4 fragColor;

void main() {
  vec4 base = vColor * vec4(uBaseColor, 1.0);
  if (uUseTex > 0.5) base *= texture(uTex, vUV);

  vec3 n = normalize(vNormal);
  float ndl = max(dot(n, normalize(uLightDir)), 0.0);
  float sky = 0.5 + 0.5 * n.y;

  vec3 col = base.rgb * (uAmbient + 0.78 * ndl) * mix(0.85, 1.06, sky);
  col = mix(col, uFogColor, clamp((length(vWorld) - uFogNear) / max(uFogFar - uFogNear, 1.0), 0.0, 1.0));
  float alpha = base.a;
  if (uReveal < 0.999) {
    // 显形前沿从楼板往上推，边缘 1.8m 的渐变带
    float edge = uReveal * (uRevealH * 1.18) - 1.8;
    alpha *= smoothstep(edge, edge + 1.8, vLocalY);
  }
  fragColor = vec4(col, alpha * uAlphaMul);
}
`;
