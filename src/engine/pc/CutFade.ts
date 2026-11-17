/**
 * 让点云切面「平整」：在每层上下边界附近把 alpha 淡出。
 * 原始切法是在高度上的硬切，边缘会露出参差的点；用一段 smoothstep 收边后，
 * 层与层之间看起来像一块干净的楼板。
 */
import type { Entity } from 'playcanvas';

const CHUNK = /* glsl */ `
uniform float uCutLo;
uniform float uCutHi;
uniform float uCutFade;

void modifySplatColor(vec3 center, inout vec4 color) {
    float lo = smoothstep(uCutLo, uCutLo + uCutFade, center.z);
    float hi = 1.0 - smoothstep(uCutHi - uCutFade, uCutHi, center.z);
    color.a *= lo * hi;
}
`;

type Mat = {
  shaderChunks?: { glsl?: { set: (k: string, v: string) => void } };
  setParameter: (n: string, v: unknown) => void;
  update: () => void;
};

export function applyCutFade(entity: Entity, lo: number, hi: number, fade = 0.35): boolean {
  const g = (entity as unknown as { gsplat?: Record<string, unknown> }).gsplat;
  const inst = (g?.instance ?? g?._instance) as { material?: Mat } | undefined;
  const mat = inst?.material ?? (g?._materialTmp as Mat | undefined);
  const glsl = mat?.shaderChunks?.glsl;
  if (!glsl) return false;
  glsl.set('gsplatModifyVS', CHUNK);
  mat.setParameter('uCutLo', lo);
  mat.setParameter('uCutHi', hi);
  mat.setParameter('uCutFade', fade);
  mat.update();
  return true;
}
