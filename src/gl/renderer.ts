// WebGL2 renderer: one lighting shader, meshes drawn with a model matrix
// + color. Deliberately small — no materials, no textures.
//
// Precision: all matrix math stays in Float64 on the CPU and is combined
// camera-relatively — the model translation is taken relative to the eye
// before multiplying, so vertex coordinates reaching the GPU are small
// even at planetary distances (a float32 ulp at Earth-radius scale is
// ~0.5 m, which would visibly wobble the vehicle). The eye is always the
// origin of the GPU's world.

import { Mat4, identity, multiply, toF32, V3 } from './mat4';
import { MeshData } from './mesh';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
uniform mat4 uMVP;      // proj · viewRot · (model relative to eye)
uniform mat4 uModelRel; // model relative to eye (for lighting position)
out vec3 vNormal;
out vec3 vRel;          // eye-relative world position
out vec3 vColor;
void main() {
  vNormal = mat3(uModelRel) * aNormal;
  vRel = (uModelRel * vec4(aPos, 1.0)).xyz;
  vColor = aColor;
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vRel;
in vec3 vColor;
uniform vec3 uColorU;
uniform float uAlpha;
uniform float uUnlit;
out vec4 frag;
void main() {
  vec3 uColor = uColorU * vColor;
  if (uUnlit > 0.5) { frag = vec4(uColor, uAlpha); return; }
  vec3 n = normalize(vNormal);
  vec3 l1 = normalize(vec3(0.55, 0.75, 0.35));
  vec3 l2 = normalize(vec3(-0.6, 0.2, -0.7));
  float diff = max(dot(n, l1), 0.0) * 0.85 + max(dot(n, l2), 0.0) * 0.25;
  vec3 v = normalize(-vRel); // eye is the origin
  float spec = pow(max(dot(reflect(-l1, n), v), 0.0), 24.0) * 0.25;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.15;
  vec3 c = uColor * (0.3 + diff) + vec3(spec + rim);
  frag = vec4(c, uAlpha);
}`;

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  count: number;
  mode: number;
  posBuf?: WebGLBuffer; // dynamic line meshes only
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private uni: Record<string, WebGLUniformLocation> = {};
  private meshes = new Map<string, GpuMesh>();
  private proj: Mat4 = identity();
  private viewRot: Mat4 = identity();
  private eye: V3 = { x: 0, y: 0, z: 0 };

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true })!;
    this.gl = gl;
    this.prog = this.buildProgram();
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private buildProgram(): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) ?? 'shader compile failed');
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
    }
    for (const name of ['uMVP', 'uModelRel', 'uColorU', 'uAlpha', 'uUnlit']) {
      this.uni[name] = gl.getUniformLocation(prog, name)!;
    }
    return prog;
  }

  mesh(key: string, build: () => MeshData): void {
    if (this.meshes.has(key)) return;
    const gl = this.gl;
    const data = build();
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = (target: number, arr: BufferSource): void => {
      gl.bindBuffer(target, gl.createBuffer());
      gl.bufferData(target, arr, gl.STATIC_DRAW);
    };
    buf(gl.ARRAY_BUFFER, data.positions);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    buf(gl.ARRAY_BUFFER, data.normals);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    if (data.colors) {
      buf(gl.ARRAY_BUFFER, data.colors);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    } else {
      gl.disableVertexAttribArray(2);
      gl.vertexAttrib3f(2, 1, 1, 1);
    }
    buf(gl.ELEMENT_ARRAY_BUFFER, data.indices);
    gl.bindVertexArray(null);
    this.meshes.set(key, { vao, count: data.indices.length, mode: gl.TRIANGLES });
  }

  /** Static line mesh (positions only). */
  lineMesh(key: string, positions: Float32Array): void {
    if (this.meshes.has(key)) return;
    this.createLines(key, positions, this.gl.STATIC_DRAW);
  }

  /** Create-or-update a dynamic line mesh (orbit paths, trails, streaks).
   * Defaults to a strip; pass `segments: true` for independent GL_LINES. */
  updateLines(key: string, positions: Float32Array, segments = false): void {
    const gl = this.gl;
    const existing = this.meshes.get(key);
    if (!existing) {
      this.createLines(key, positions, gl.DYNAMIC_DRAW, segments ? gl.LINES : gl.LINE_STRIP);
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, existing.posBuf!);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    existing.count = positions.length / 3;
  }

  private createLines(key: string, positions: Float32Array, usage: number, mode?: number): void {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, usage);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.vertexAttrib3f(1, 0, 1, 0);
    gl.disableVertexAttribArray(2);
    gl.vertexAttrib3f(2, 1, 1, 1);
    gl.bindVertexArray(null);
    this.meshes.set(key, { vao, count: positions.length / 3, mode: mode ?? gl.LINES, posBuf });
  }

  /** viewRot: the camera's lookAt rotation with zero translation; eye: the
   * camera position in world coordinates (float64 — subtracted per draw). */
  begin(proj: Mat4, viewRot: Mat4, eye: V3, clear: [number, number, number] = [0.01, 0.012, 0.03]): void {
    const gl = this.gl;
    this.proj = proj;
    this.viewRot = viewRot;
    this.eye = eye;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
  }

  draw(
    key: string,
    model: Mat4,
    color: [number, number, number],
    alpha = 1,
    unlit = false,
    onTop = false,
    depthPush = false,
  ): void {
    const gl = this.gl;
    const m = this.meshes.get(key);
    if (!m) return;
    // depthPush shoves this draw slightly deeper in the depth buffer —
    // used for the global planet sphere so near-coplanar local geometry
    // (pad deck, local ground cap) always wins instead of z-fighting.
    if (depthPush) {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(2, 4);
    }
    // Camera-relative model: translation minus eye, in float64.
    const rel = Float64Array.from(model);
    rel[12]! -= this.eye.x;
    rel[13]! -= this.eye.y;
    rel[14]! -= this.eye.z;
    const mvp = multiply(this.proj, multiply(this.viewRot, rel));
    gl.uniformMatrix4fv(this.uni.uMVP!, false, toF32(mvp));
    gl.uniformMatrix4fv(this.uni.uModelRel!, false, toF32(rel));
    gl.uniform3f(this.uni.uColorU!, color[0], color[1], color[2]);
    gl.uniform1f(this.uni.uAlpha!, alpha);
    gl.uniform1f(this.uni.uUnlit!, unlit ? 1 : 0);
    gl.depthMask(alpha >= 1);
    if (onTop) gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(m.vao);
    if (m.mode === gl.TRIANGLES) gl.drawElements(m.mode, m.count, gl.UNSIGNED_SHORT, 0);
    else gl.drawArrays(m.mode, 0, m.count);
    gl.bindVertexArray(null);
    if (onTop) gl.enable(gl.DEPTH_TEST);
    if (depthPush) gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
  }
}
