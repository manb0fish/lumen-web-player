import type { MediaFrame, PlanarFrame, RenderSettings } from '../core/types';
import {
  describeChain,
  type ExternalPacking,
  frameDisplaySize,
  gamutMapCode,
  isHdrTransfer,
  kernelCode,
  packingCode,
  pqEotf,
  primariesCode,
  rotationCode,
  toneMapCode,
  transferCode,
  yuvUniforms,
} from './color';
import { classifyExternal, ExternalHdrTracker, PROBE_SIZE, PROBE_TILE, probeOrigins, sampleBrowserSdr } from './external-hdr';
import {
  GLSL_DEBAND,
  GLSL_EASU,
  GLSL_FINAL,
  GLSL_INGEST_EXTERNAL,
  GLSL_INGEST_PLANAR,
  GLSL_MEASURE_EXTERNAL,
  GLSL_MEASURE_PLANAR,
  GLSL_PEAK_REDUCE,
  GLSL_PROBE_EXTERNAL,
  GLSL_SCALE,
  GLSL_VERT,
} from './glsl';
import {
  choosePeak,
  describeMeasuredPeak,
  PEAK_GRID,
  PEAK_SCENE_HIGH,
  PEAK_SCENE_LOW,
  peakKey,
  type PeakStep,
  peakTaps,
  PeakTracker,
} from './peak';
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

/** What every program that reads planar frames is given (PLANAR_SOURCE in glsl.ts). */
const PLANAR_UNIFORMS = ['uTexY', 'uTexU', 'uTexV', 'uM0', 'uM1', 'uM2', 'uOff', 'uScl', 'uPack', 'uMode'];

/**
 * WebGL2 fallback renderer: same pass chain as WebGPU, GLSL ES 3.00, RGBA16F intermediates when
 * available. HDR frames decoded by the browser arrive here as coded samples too, but only 8 bits
 * of them (texImage2D quantises whatever the target format): colours are right, fine gradients
 * can band where WebGPU's stay smooth. The HDR peak is measured as on WebGPU (peak.ts) wherever
 * float textures can be rendered to.
 */
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
  private pProbe!: Program;
  private pMeasureExt: Program | null = null;
  private pMeasurePlanar: Program | null = null;
  private pReduce: Program | null = null;
  private peakGrid: Target | null = null;
  /** Ping-pong: the reduce pass reads the state of the previous picture and writes the other one. */
  private peakState: Target[] = [];
  private peakCur = 0;
  private peak = new PeakTracker();
  /** Null until the first HDR picture asks: the measuring passes are built then, not at start-up. */
  private canMeasure: boolean | null = null;
  private float32 = false;
  /** The frame on the canvas was tone-mapped with the measured peak. */
  private peakLive = false;
  private peakReading = false;
  private probe: Target | null = null;
  private extHdr = new ExternalHdrTracker('webgl2');
  private probeTimer = 0;
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
    this.float32 = !!gl.getExtension('EXT_color_buffer_float');
    this.floatTargets = this.float32 || !!gl.getExtension('EXT_color_buffer_half_float');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.detail = `${name}${this.floatTargets ? '' : ' (8-bit intermediates)'}`;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.pExt = this.program('ingest-external', GLSL_INGEST_EXTERNAL, ['uTex', 'uMode', 'uOpt', 'uPeak', 'uPeakState']);
    this.pProbe = this.program('probe-external', GLSL_PROBE_EXTERNAL, ['uTex', 'uOx', 'uOy', 'uTile']);
    this.pPlanar = this.program('ingest-planar', GLSL_INGEST_PLANAR, [...PLANAR_UNIFORMS, 'uPeak', 'uOpt', 'uPeakState']);
    this.pDeband = this.program('deband', GLSL_DEBAND, ['uTex', 'uP']);
    this.pScale = this.program('scale', GLSL_SCALE, ['uTex', 'uSize', 'uOpt']);
    this.pEasu = this.program('easu', GLSL_EASU, ['uTex', 'uSize']);
    this.pFinal = this.program('final', GLSL_FINAL, ['uTex', 'uP']);
    // The measured peak is a running average: full floats where they can be rendered to, or its
    // small steps would be rounded away. The ingest shaders name the state, so it exists from the
    // start; everything else about measuring waits for the first HDR picture (measuring()).
    const state = this.float32 ? gl.RGBA32F : gl.RGBA16F;
    this.peakState = [this.fixedTarget(1, state), this.fixedTarget(1, state)];
  }

  /**
   * Whether this context can measure the HDR peak. The first call builds the measuring programs
   * and the grid, so that playback of SDR never pays for them. It makes and binds a texture:
   * call it before a frame's own textures are bound.
   */
  private measuring(): boolean {
    if (this.canMeasure !== null) return this.canMeasure;
    this.canMeasure = false;
    const gl = this.gl;
    if (!this.floatTargets) return false;
    try {
      this.pMeasureExt = this.program('measure-external', GLSL_MEASURE_EXTERNAL, ['uTex', 'uMode', 'uTaps']);
      this.pMeasurePlanar = this.program('measure-planar', GLSL_MEASURE_PLANAR, [...PLANAR_UNIFORMS, 'uTaps']);
      this.pReduce = this.program('peak-reduce', GLSL_PEAK_REDUCE, ['uGrid', 'uPrev', 'uP']);
      const grid = this.fixedTarget(PEAK_GRID, gl.RGBA16F);
      this.peakGrid = grid;
      const complete = (t: Target) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return ok;
      };
      this.canMeasure = [grid, ...this.peakState].every(complete);
    } catch {
      /* a driver that cannot compile them: the peak comes from the metadata or the fixed value */
    }
    return this.canMeasure;
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

  /** A square float target of a fixed size. */
  private fixedTarget(size: number, format: number): Target {
    const gl = this.gl;
    const tex = this.newTexture(gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, size, size, 0, gl.RGBA, format === gl.RGBA32F ? gl.FLOAT : gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w: size, h: size };
  }

  /**
   * The two passes that measure a new picture (peak.ts). The measuring program is in use, with
   * the frame bound as the ingest pass will see it. Afterwards peakState[peakCur] is the state
   * to tone-map this picture with. Uses texture units 4 and 5, which no ingest pass touches.
   */
  private measurePeak(taps: WebGLUniformLocation | null, width: number, height: number, step: PeakStep): void {
    const gl = this.gl;
    const grid = this.peakGrid!;
    const reduce = this.pReduce!;
    const n = peakTaps(width, height);
    gl.uniform2i(taps, n[0], n[1]);
    this.draw(grid.fbo, grid.w, grid.h);
    const prev = this.peakCur;
    this.peakCur ^= 1;
    gl.useProgram(reduce.prog);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, grid.tex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.peakState[prev].tex);
    gl.uniform1i(reduce.u.uGrid, 4);
    gl.uniform1i(reduce.u.uPrev, 5);
    gl.uniform4f(reduce.u.uP, step.reset ? 1 : 0, step.alpha, PEAK_SCENE_LOW, PEAK_SCENE_HIGH);
    this.draw(this.peakState[this.peakCur].fbo, 1, 1);
  }

  /** Texture unit 3 is the measured peak, for the ingest program now in use. */
  private bindPeakState(p: Program): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.peakState[this.peakCur].tex);
    gl.uniform1i(p.u.uPeakState, 3);
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
    let packing: ExternalPacking = 'converted';
    let peakDetail = '';
    let measured = false;
    // Asked before any of the frame's textures are bound (the first answer builds the passes).
    const ours = frame.kind === 'planar' || settings.externalHdr;
    const canMeasure = ours && settings.hdrPeakSource === 'measured' && isHdrTransfer(frame.color) && this.measuring();

    const A = this.target('A', disp.width, disp.height);

    if (frame.kind === 'planar') {
      this.uploadPlanar(frame);
      const yuv = yuvUniforms(frame.color, frame.bitDepth, frame.height);
      const m = yuv.matrix;
      // The planes as R'G'B', for whichever program reads them.
      const source = (p: Program) => {
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
        gl.uniform4i(p.u.uMode, transferCode(frame.color), primariesCode(frame.color), toneMapCode(settings.toneMapping), rot);
      };
      const peak = isHdrTransfer(frame.color) ? choosePeak(frame.color, settings, canMeasure) : null;
      measured = peak?.source === 'measured';
      peakDetail = peak?.detail ?? '';
      const step = measured ? this.peak.step(frame, peakKey(frame, '')) : null;
      if (step) {
        source(this.pMeasurePlanar!);
        this.measurePeak(this.pMeasurePlanar!.u.uTaps, frame.width, frame.height, step);
      }
      const p = this.pPlanar;
      source(p);
      gl.uniform1f(p.u.uPeak, peak?.nits ?? settings.hdrPeak);
      gl.uniform2i(p.u.uOpt, gamutMapCode(settings.gamutMapping), measured ? 1 : 0);
      this.bindPeakState(p);
      this.draw(A.fbo, A.w, A.h);
    } else {
      if (!this.extTex) this.extTex = this.newTexture(gl.LINEAR);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.extTex);
      const src = frame.kind === 'videoframe' ? frame.frame : frame.el;
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      } catch {
        return;
      }
      // Reading back is synchronous here, so even the first frame is drawn with a checked packing.
      if (settings.externalHdr && this.extHdr.wantsProbe(frame, t0)) this.probeExternal(src, frame, t0);
      packing = settings.externalHdr ? this.extHdr.packingFor(frame) : 'converted';
      // The upload as coded samples, for whichever program reads it.
      const source = (p: Program) => {
        gl.useProgram(p.prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.extTex);
        gl.uniform1i(p.u.uTex, 0);
        gl.uniform4i(p.u.uMode, packingCode(packing), transferCode(frame.color), primariesCode(frame.color), rot);
      };
      // Only samples that go through our tone curve have a peak to speak of.
      const peak = packing !== 'converted' && isHdrTransfer(frame.color) ? choosePeak(frame.color, settings, canMeasure) : null;
      measured = peak?.source === 'measured';
      peakDetail = peak?.detail ?? '';
      const step = measured ? this.peak.step(frame, peakKey(frame, packing)) : null;
      if (step) {
        source(this.pMeasureExt!);
        this.measurePeak(this.pMeasureExt!.u.uTaps, frame.width, frame.height, step);
      }
      source(this.pExt);
      gl.uniform3i(this.pExt.u.uOpt, toneMapCode(settings.toneMapping), gamutMapCode(settings.gamutMapping), measured ? 1 : 0);
      gl.uniform1f(this.pExt.u.uPeak, peak?.nits ?? settings.hdrPeak);
      this.bindPeakState(this.pExt);
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
    this.stats.chain = describeChain(frame, settings, outW, outH, packing);
    if (frame.kind !== 'planar' && packing !== 'converted') this.stats.hdrHandover = this.extHdr.detail;
    // A measured peak is known to the GPU only: refreshStats() fills in its text.
    if (!measured || !this.peakLive) this.stats.hdrPeak = peakDetail;
    this.peakLive = measured;
    this.probeLater(frame, settings);
  }

  /** Reads the state through a pixel-pack buffer and a fence, so that nothing waits for the GPU. */
  readPeak(): Promise<{ peak: number; mean: number } | null> {
    const gl = this.gl;
    if (this.destroyed || !this.peakLive || gl.isContextLost()) return Promise.resolve(null);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.peakState[this.peakCur].fbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return new Promise((resolve) => {
      const poll = () => {
        if (this.destroyed || gl.isContextLost() || !sync) {
          resolve(null);
          return;
        }
        const status = gl.clientWaitSync(sync, 0, 0);
        if (status === gl.TIMEOUT_EXPIRED) {
          setTimeout(poll, 4);
          return;
        }
        gl.deleteSync(sync);
        let out: { peak: number; mean: number } | null = null;
        if (status !== gl.WAIT_FAILED) {
          const state = new Float32Array(4);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, state);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          out = { peak: pqEotf(state[0]), mean: pqEotf(state[1]) };
        }
        gl.deleteBuffer(buf);
        resolve(out);
      };
      setTimeout(poll, 0);
    });
  }

  refreshStats(): void {
    if (this.peakReading || !this.peakLive) return;
    this.peakReading = true;
    void this.readPeak().then((v) => {
      this.peakReading = false;
      if (v && this.peakLive && !this.destroyed) this.stats.hdrPeak = describeMeasuredPeak(v.peak, v.mean);
    });
  }

  /** A paused player draws nothing new: come back by ourselves while a frame is still unchecked. */
  private probeLater(frame: MediaFrame, settings: RenderSettings): void {
    if (this.probeTimer || !settings.externalHdr) return;
    const wait = this.extHdr.retryIn(frame, performance.now());
    if (wait === null) return;
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = 0;
      if (!this.destroyed && this.last) this.render(this.last.frame, this.last.settings);
    }, wait + 30);
  }

  /**
   * Compare the texture just uploaded from an HDR frame with the browser's 2D-canvas rendition of
   * the same pixels (external-hdr.ts). Expects the upload to be bound to texture unit 0.
   */
  private probeExternal(src: VideoFrame | HTMLVideoElement, frame: MediaFrame, now: number): void {
    const gl = this.gl;
    const origins = probeOrigins(frame.width, frame.height);
    if (!origins) {
      this.extHdr.giveUp();
      return;
    }
    const sdr = sampleBrowserSdr(src, origins);
    if (!sdr) {
      this.extHdr.miss(now);
      return;
    }
    if (!this.probe) {
      const tex = this.newTexture(gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PROBE_SIZE, PROBE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.probe = { tex, fbo, w: PROBE_SIZE, h: PROBE_SIZE };
    }
    this.useWithTexture(this.pProbe, this.extTex!);
    gl.uniform4f(this.pProbe.u.uOx, origins.x[0], origins.x[1], origins.x[2], origins.x[3]);
    gl.uniform4f(this.pProbe.u.uOy, origins.y[0], origins.y[1], origins.y[2], origins.y[3]);
    gl.uniform1i(this.pProbe.u.uTile, PROBE_TILE);
    this.draw(this.probe.fbo, PROBE_SIZE, PROBE_SIZE);
    const px = new Uint8Array(PROBE_SIZE * PROBE_SIZE * 4);
    gl.readPixels(0, 0, PROBE_SIZE, PROBE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.extHdr.report(frame, classifyExternal(px, sdr, frame.color, this.extHdr.candidates()), now);
    this.stats.hdrHandover = this.extHdr.detail;
  }

  snapshot(): HTMLCanvasElement | null {
    if (!this.last || this.destroyed) return null;
    this.render(this.last.frame, this.last.settings);
    return copyCanvas(this.canvas);
  }

  forget(): void {
    this.last = null;
    this.extHdr.reset();
    this.peak.reset();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.last = null;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    clearTimeout(this.probeTimer);
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
      if (this.probe) {
        this.deleteTexture(this.probe.tex);
        gl.deleteFramebuffer(this.probe.fbo);
        this.probe = null;
      }
      for (const t of [this.peakGrid, ...this.peakState]) {
        if (t) {
          this.deleteTexture(t.tex);
          gl.deleteFramebuffer(t.fbo);
        }
      }
      this.peakGrid = null;
      this.peakState = [];
      const programs = [this.pExt, this.pPlanar, this.pDeband, this.pScale, this.pEasu, this.pFinal, this.pProbe];
      for (const p of [...programs, this.pMeasureExt, this.pMeasurePlanar, this.pReduce]) {
        if (p) gl.deleteProgram(p.prog);
      }
      gl.deleteVertexArray(this.vao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.canvas.remove();
  }
}
