import type { MediaFrame, PlanarFrame, RenderSettings } from '../core/types';
import { describeChain, frameDisplaySize, kernelCode, primariesCode, rotationCode, toneMapCode, transferCode, yuvUniforms } from './color';
import { GLSL_DEBAND, GLSL_EASU, GLSL_FINAL, GLSL_INGEST_EXTERNAL, GLSL_INGEST_PLANAR, GLSL_SCALE, GLSL_VERT } from './glsl';
import { copyCanvas, countTexture, makeCanvas, newStats, type Renderer, type RendererStats } from './renderer';

interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

interface Plane {
  tex: WebGLTexture;
  w: number;
  h: number;
  wide: boolean;
}

/** WebGL2 fallback renderer: same pass chain as WebGPU, GLSL ES 3.00, RGBA16F intermediates when available. */
export class WebGL2Renderer implements Renderer {
  readonly kind = 'webgl2' as const;
  readonly canvas = makeCanvas();
  detail = '';
  stats: RendererStats = newStats();
  onLost: ((reason: string) => void) | null = null;

  private gl!: WebGL2RenderingContext;
  private vao!: WebGLVertexArrayObject;
  private pExt!: Program;
  private pPlanar!: Program;
  private pDeband!: Program;
  private pScale!: Program;
  private pEasu!: Program;
  private pFinal!: Program;
  private floatTargets = false;
  private targets: Record<'A' | 'B' | 'C', Target | null> = { A: null, B: null, C: null };
  private planes: Array<Plane | null> = [null, null, null];
  private extTex: WebGLTexture | null = null;
  private last: { frame: MediaFrame; settings: RenderSettings } | null = null;
  private frameNo = 0;
  private destroyed = false;
  private onContextLost = (e: Event) => {
    e.preventDefault();
    if (!this.destroyed) this.onLost?.('webglcontextlost');
  };

  async init(): Promise<void> {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.floatTargets = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.detail = `${name}${this.floatTargets ? '' : ' (8-bit intermediates)'}`;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.pExt = this.program('ingest-external', GLSL_INGEST_EXTERNAL, ['uTex', 'uRot']);
    this.pPlanar = this.program('ingest-planar', GLSL_INGEST_PLANAR, [
      'uTexY',
      'uTexU',
      'uTexV',
      'uM0',
      'uM1',
      'uM2',
      'uOff',
      'uScl',
      'uPack',
      'uPeak',
      'uMode',
    ]);
    this.pDeband = this.program('deband', GLSL_DEBAND, ['uTex', 'uP']);
    this.pScale = this.program('scale', GLSL_SCALE, ['uTex', 'uSize', 'uOpt']);
    this.pEasu = this.program('easu', GLSL_EASU, ['uTex', 'uSize']);
    this.pFinal = this.program('final', GLSL_FINAL, ['uTex', 'uP']);
  }

  private program(label: string, frag: string, uniforms: string[]): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`GLSL ${label}: ${log}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, GLSL_VERT);
    const fs = compile(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`GLSL link ${label}: ${gl.getProgramInfoLog(prog)}`);
    }
    const u: Program['u'] = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
    return { prog, u };
  }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (this.last) this.render(this.last.frame, this.last.settings);
    }
  }

  private newTexture(filter: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    countTexture(this.stats, 1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private deleteTexture(tex: WebGLTexture | null): void {
    if (!tex) return;
    this.gl.deleteTexture(tex);
    countTexture(this.stats, -1);
  }

  private target(key: 'A' | 'B' | 'C', w: number, h: number): Target {
    const gl = this.gl;
    const cur = this.targets[key];
    if (cur && cur.w === w && cur.h === h) return cur;
    if (cur) {
      this.deleteTexture(cur.tex);
      gl.deleteFramebuffer(cur.fbo);
    }
    const tex = this.newTexture(gl.LINEAR);
    if (this.floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { tex, fbo, w, h };
    this.targets[key] = t;
    return t;
  }

  private uploadPlanar(frame: PlanarFrame): void {
    const gl = this.gl;
    const wide = frame.bitDepth > 8;
    const dims: Array<[number, number]> = [
      [frame.width, frame.height],
      [frame.chromaWidth, frame.chromaHeight],
      [frame.chromaWidth, frame.chromaHeight],
    ];
    for (let i = 0; i < 3; i++) {
      const [w, h] = dims[i];
      let p = this.planes[i];
      gl.activeTexture(gl.TEXTURE0 + i);
      if (!p || p.w !== w || p.h !== h || p.wide !== wide) {
        if (p) this.deleteTexture(p.tex);
        const tex = this.newTexture(gl.LINEAR);
        if (wide) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, null);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
        p = { tex, w, h, wide };
        this.planes[i] = p;
      }
      gl.bindTexture(gl.TEXTURE_2D, p.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, wide ? gl.RG : gl.RED, gl.UNSIGNED_BYTE, frame.planes[i]);
    }
  }

  private draw(fbo: WebGLFramebuffer | null, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private useWithTexture(p: Program, tex: WebGLTexture): void {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.uTex, 0);
  }

  render(frame: MediaFrame, settings: RenderSettings): void {
    if (this.destroyed) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const t0 = performance.now();
    const outW = this.canvas.width;
    const outH = this.canvas.height;
    const disp = frameDisplaySize(frame);
    if (!outW || !outH || !disp.width || !disp.height) return;
    const rot = rotationCode(frame.rotation);
    this.frameNo++;
    gl.bindVertexArray(this.vao);

    const A = this.target('A', disp.width, disp.height);

    if (frame.kind === 'planar') {
      this.uploadPlanar(frame);
      const p = this.pPlanar;
      const yuv = yuvUniforms(frame.color, frame.bitDepth, frame.height);
      const m = yuv.matrix;
      gl.useProgram(p.prog);
      gl.uniform1i(p.u.uTexY, 0);
      gl.uniform1i(p.u.uTexU, 1);
      gl.uniform1i(p.u.uTexV, 2);
      gl.uniform3f(p.u.uM0, m[0], m[1], m[2]);
      gl.uniform3f(p.u.uM1, m[3], m[4], m[5]);
      gl.uniform3f(p.u.uM2, m[6], m[7], m[8]);
      gl.uniform3f(p.u.uOff, yuv.offset[0], yuv.offset[1], yuv.offset[2]);
      gl.uniform3f(p.u.uScl, yuv.scale[0], yuv.scale[1], yuv.scale[2]);
      gl.uniform2f(p.u.uPack, yuv.pack[0], yuv.pack[1]);
      gl.uniform1f(p.u.uPeak, settings.hdrPeak);
      gl.uniform4i(p.u.uMode, transferCode(frame.color), primariesCode(frame.color), toneMapCode(settings.toneMapping), rot);
      this.draw(A.fbo, A.w, A.h);
    } else {
      if (!this.extTex) this.extTex = this.newTexture(gl.LINEAR);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.extTex);
      try {
        const src = frame.kind === 'videoframe' ? frame.frame : frame.el;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      } catch {
        return;
      }
      gl.useProgram(this.pExt.prog);
      gl.uniform1i(this.pExt.u.uTex, 0);
      gl.uniform1i(this.pExt.u.uRot, rot);
      this.draw(A.fbo, A.w, A.h);
    }
    let cur: Target = A;

    if (settings.deband) {
      const B = this.target('B', disp.width, disp.height);
      this.useWithTexture(this.pDeband, cur.tex);
      gl.uniform4f(this.pDeband.u.uP, 0.016, 18, 0.004, this.frameNo % 4096);
      this.draw(B.fbo, B.w, B.h);
      cur = B;
    }

    if (settings.scaler !== 'bilinear' || settings.sharpen > 0) {
      const C = this.target('C', outW, outH);
      const upscaling = outW > disp.width || outH > disp.height;
      if (settings.scaler === 'fsr' && upscaling) {
        this.useWithTexture(this.pEasu, cur.tex);
        gl.uniform4f(this.pEasu.u.uSize, cur.w, cur.h, outW, outH);
        this.draw(C.fbo, C.w, C.h);
      } else {
        const kernel = settings.scaler === 'fsr' ? 1 : kernelCode(settings.scaler);
        this.useWithTexture(this.pScale, cur.tex);
        gl.uniform4f(this.pScale.u.uSize, cur.w, cur.h, outW, outH);
        gl.uniform4f(this.pScale.u.uOpt, kernel, 0.8, settings.linearScaling ? 1 : 0, 0);
        this.draw(C.fbo, C.w, C.h);
      }
      cur = C;
    }

    this.useWithTexture(this.pFinal, cur.tex);
    gl.uniform4f(this.pFinal.u.uP, settings.sharpen, settings.dither ? 1 : 0, this.frameNo % 4096, 0);
    this.draw(null, outW, outH);

    this.last = { frame, settings };
    this.stats.framesRendered++;
    this.stats.lastRenderMs = performance.now() - t0;
    this.stats.chain = describeChain(frame, settings, outW, outH);
  }

  snapshot(): HTMLCanvasElement | null {
    if (!this.last || this.destroyed) return null;
    this.render(this.last.frame, this.last.settings);
    return copyCanvas(this.canvas);
  }

  forget(): void {
    this.last = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.last = null;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    const gl = this.gl;
    if (gl) {
      for (const key of ['A', 'B', 'C'] as const) {
        const t = this.targets[key];
        if (t) {
          this.deleteTexture(t.tex);
          gl.deleteFramebuffer(t.fbo);
          this.targets[key] = null;
        }
      }
      for (let i = 0; i < 3; i++) {
        const p = this.planes[i];
        if (p) {
          this.deleteTexture(p.tex);
          this.planes[i] = null;
        }
      }
      this.deleteTexture(this.extTex);
      this.extTex = null;
      for (const p of [this.pExt, this.pPlanar, this.pDeband, this.pScale, this.pEasu, this.pFinal]) {
        if (p) gl.deleteProgram(p.prog);
      }
      gl.deleteVertexArray(this.vao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.canvas.remove();
  }
}
