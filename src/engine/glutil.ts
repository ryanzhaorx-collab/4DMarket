/** WebGL2 低层工具：着色器编译、uniform 缓存、纹理/缓冲创建。 */

export class GLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GLError';
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new GLError(`创建着色器失败: ${label}`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new GLError(`着色器编译失败 [${label}]: ${log}`);
  }
  return sh;
}

export interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  attribs: Map<string, number>;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  label: string,
): ProgramInfo {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${label}.vs`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}.fs`);
  const program = gl.createProgram();
  if (!program) throw new GLError('创建 program 失败');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new GLError(`Program 链接失败 [${label}]: ${log}`);
  }
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    uniforms.set(name, gl.getUniformLocation(program, name));
  }
  const attribs = new Map<string, number>();
  const an = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number;
  for (let i = 0; i < an; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (info) attribs.set(info.name, gl.getAttribLocation(program, info.name));
  }
  return { program, uniforms, attribs };
}

export function u(prog: ProgramInfo, name: string): WebGLUniformLocation | null {
  return prog.uniforms.get(name) ?? null;
}

export interface TextureOptions {
  width: number;
  height: number;
  internalFormat: number;
  format: number;
  type: number;
  data?: ArrayBufferView | null;
  filter?: number;
  wrap?: number;
}

export function createTexture(gl: WebGL2RenderingContext, o: TextureOptions): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new GLError('创建纹理失败');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, o.internalFormat, o.width, o.height, 0, o.format, o.type, (o.data ?? null) as ArrayBufferView | null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, o.filter ?? gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, o.filter ?? gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.wrap ?? gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, o.wrap ?? gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export function textureWidthFor(count: number, maxWidth: number): { width: number; height: number } {
  const width = Math.min(maxWidth, Math.max(1, count));
  const height = Math.max(1, Math.ceil(count / width));
  return { width, height };
}

export function createQuadVAO(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new GLError('创建 VAO 失败');
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // TRIANGLE_STRIP 的四角
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return vao;
}

export function isWebGL2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}
