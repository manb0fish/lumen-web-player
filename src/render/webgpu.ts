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
import { classifyExternal, ExternalHdrTracker, halfToFloat, PROBE_SIZE, PROBE_TILE, probeOrigins, sampleBrowserSdr } from './external-hdr';
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
import {
  WGSL_DEBAND,
  WGSL_EASU,
  WGSL_FINAL,
  WGSL_INGEST_EXTERNAL,
  WGSL_INGEST_PLANAR,
  WGSL_MEASURE_EXTERNAL,
  WGSL_MEASURE_PLANAR,
  WGSL_PEAK_REDUCE,
  WGSL_PROBE_EXTERNAL,
  WGSL_SCALE,
} from './wgsl';

interface Target {
  tex: GPUTexture;
  view: GPUTextureView;
  w: number;
  h: number;
}

interface Plane {
  tex: GPUTexture;
  view: GPUTextureView;
  w: number;
  h: number;
  format: GPUTextureFormat;
}

const INTERMEDIATE: GPUTextureFormat = 'rgba16float';
/** The measured peak is a running average: full floats, or its small steps would be rounded away. */
const PEAK_STATE: GPUTextureFormat = 'rgba32float';

/**
 * WebGPU renderer.
 *  - VideoFrame / <video> sources are imported zero-copy with importExternalTexture. SDR arrives
 *    converted by the browser; HDR arrives as coded samples, which the ingest shader unpacks and
 *    colour-manages itself (external-hdr.ts explains, and checks, what was handed over).
 *  - Software-decoded pictures are uploaded as three planes (R8 for 8-bit, RG8-packed LE16 for
 *    10/12-bit) and converted by our own shader: range, matrix, PQ/HLG EOTF, tone map, gamut.
 *  - The peak an HDR picture is tone-mapped with can be measured on the GPU (peak.ts): two small
 *    passes ahead of the ingest, whose result the ingest shader reads from a 1x1 texture.
 *  - Optional deband, bicubic / Lanczos-3 / EASU scaling, RCAS sharpening and dithering.
 */
export class WebGPURenderer implements Renderer {
  readonly kind = 'webgpu' as const;
  readonly canvas = makeCanvas();
  detail = '';
  stats: RendererStats = newStats();
  onLost: ((reason: string) => void) | null = null;

  private device!: GPUDevice;
  private ctx!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private sampler!: GPUSampler;
  private pExt!: GPURenderPipeline;
  private pPlanar!: GPURenderPipeline;
  private pDeband!: GPURenderPipeline;
  private pScale!: GPURenderPipeline;
  private pEasu!: GPURenderPipeline;
  private pFinal!: GPURenderPipeline;
  private pProbe!: GPURenderPipeline;
  private pMeasureExt!: GPURenderPipeline;
  private pMeasurePlanar!: GPURenderPipeline;
  private pReduce!: GPURenderPipeline;
  private uReduce!: GPUBuffer;
  private peakGrid: Target | null = null;
  /** Ping-pong: the reduce pass reads the state of the previous picture and writes the other one. */
  private peakState: Target[] = [];
  private peakCur = 0;
  private peak = new PeakTracker();
  /** The frame on the canvas was tone-mapped with the measured peak. */
  private peakLive = false;
  private peakReading = false;
  private uProbe!: GPUBuffer;
  private probeTex: GPUTexture | null = null;
  private probeBuf: GPUBuffer | null = null;
  private extHdr = new ExternalHdrTracker('webgpu');
  private probeTimer = 0;
  private uExt!: GPUBuffer;
  private uPlanar!: GPUBuffer;
  private uDeband!: GPUBuffer;
  private uScale!: GPUBuffer;
  private uFinal!: GPUBuffer;
  private targets: Record<'A' | 'B' | 'C', Target | null> = { A: null, B: null, C: null };
  private planes: Array<Plane | null> = [null, null, null];
  private last: { frame: MediaFrame; settings: RenderSettings } | null = null;
  private frameNo = 0;
  private destroyed = false;

  async init(): Promise<void> {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    this.device = device;
    const info: any = (adapter as any).info ?? {};
    this.detail = [info.vendor, info.architecture, info.description || info.device].filter(Boolean).join(' ') || 'WebGPU';
    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not create a WebGPU canvas context');
    this.ctx = ctx;
    this.format = gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    device.pushErrorScope('validation');
    const [pExt, pPlanar, pDeband, pScale, pEasu, pFinal, pProbe, pMeasureExt, pMeasurePlanar, pReduce] = await Promise.all([
      this.pipeline('ingest-external', WGSL_INGEST_EXTERNAL, INTERMEDIATE),
      this.pipeline('ingest-planar', WGSL_INGEST_PLANAR, INTERMEDIATE),
      this.pipeline('deband', WGSL_DEBAND, INTERMEDIATE),
      this.pipeline('scale', WGSL_SCALE, INTERMEDIATE),
      this.pipeline('easu', WGSL_EASU, INTERMEDIATE),
      this.pipeline('final', WGSL_FINAL, this.format),
      this.pipeline('probe-external', WGSL_PROBE_EXTERNAL, INTERMEDIATE),
      this.pipeline('measure-external', WGSL_MEASURE_EXTERNAL, INTERMEDIATE),
      this.pipeline('measure-planar', WGSL_MEASURE_PLANAR, INTERMEDIATE),
      this.pipeline('peak-reduce', WGSL_PEAK_REDUCE, PEAK_STATE),
    ]);
    const err = await device.popErrorScope();
    if (err) throw new Error(`WebGPU pipeline validation failed: ${err.message}`);
    this.pExt = pExt;
    this.pPlanar = pPlanar;
    this.pDeband = pDeband;
    this.pScale = pScale;
    this.pEasu = pEasu;
    this.pFinal = pFinal;
    this.pProbe = pProbe;
    this.pMeasureExt = pMeasureExt;
    this.pMeasurePlanar = pMeasurePlanar;
    this.pReduce = pReduce;

    const ubuf = (size: number) => device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uExt = ubuf(48);
    this.uProbe = ubuf(48);
    this.uPlanar = ubuf(128);
    this.uReduce = ubuf(16);
    this.uDeband = ubuf(16);
    this.uScale = ubuf(32);
    this.uFinal = ubuf(16);
    // The ingest shaders name the state, so it exists from the start; the grid comes with the
    // first picture that is measured.
    this.peakState = [this.fixedTarget('peak-state-0', 1, PEAK_STATE), this.fixedTarget('peak-state-1', 1, PEAK_STATE)];

    device.lost.then((info) => {
      if (!this.destroyed) this.onLost?.(info.message || String(info.reason));
    });
  }

  private async pipeline(label: string, code: string, format: GPUTextureFormat): Promise<GPURenderPipeline> {
    const module = this.device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
      throw new Error(`WGSL ${label}: ` + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
    }
    return this.device.createRenderPipelineAsync({
      label,
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
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

  private target(key: 'A' | 'B' | 'C', w: number, h: number): Target {
    const cur = this.targets[key];
    if (cur && cur.w === w && cur.h === h) return cur;
    if (cur) {
      cur.tex.destroy();
      countTexture(this.stats, -1);
    }
    const tex = this.device.createTexture({
      label: `target-${key}`,
      size: { width: w, height: h },
      format: INTERMEDIATE,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    countTexture(this.stats, 1);
    const t = { tex, view: tex.createView(), w, h };
    this.targets[key] = t;
    return t;
  }

  private fixedTarget(label: string, size: number, format: GPUTextureFormat): Target {
    const tex = this.device.createTexture({
      label,
      size: { width: size, height: size },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    countTexture(this.stats, 1);
    return { tex, view: tex.createView(), w: size, h: size };
  }

  /**
   * The two passes that measure a new picture (peak.ts). `source` binds the frame as the ingest
   * pass will see it. Afterwards peakState[peakCur] is the state to tone-map this picture with.
   */
  private measurePeak(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, source: GPUBindGroupEntry[], step: PeakStep): void {
    const device = this.device;
    const grid = (this.peakGrid ??= this.fixedTarget('peak-grid', PEAK_GRID, INTERMEDIATE));
    this.pass(encoder, pipeline, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: source }), grid.view);
    const prev = this.peakCur;
    this.peakCur ^= 1;
    device.queue.writeBuffer(this.uReduce, 0, new Float32Array([step.reset ? 1 : 0, step.alpha, PEAK_SCENE_LOW, PEAK_SCENE_HIGH]));
    const bind = device.createBindGroup({
      layout: this.pReduce.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uReduce } },
        { binding: 1, resource: grid.view },
        { binding: 2, resource: this.peakState[prev].view },
      ],
    });
    this.pass(encoder, this.pReduce, bind, this.peakState[this.peakCur].view);
  }

  private plane(i: number, w: number, h: number, format: GPUTextureFormat): Plane {
    const cur = this.planes[i];
    if (cur && cur.w === w && cur.h === h && cur.format === format) return cur;
    if (cur) {
      cur.tex.destroy();
      countTexture(this.stats, -1);
    }
    const tex = this.device.createTexture({
      label: `plane-${i}`,
      size: { width: w, height: h },
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    countTexture(this.stats, 1);
    const p = { tex, view: tex.createView(), w, h, format };
    this.planes[i] = p;
    return p;
  }

  private uploadPlanar(frame: PlanarFrame): [Plane, Plane, Plane] {
    const wide = frame.bitDepth > 8;
    const format: GPUTextureFormat = wide ? 'rg8unorm' : 'r8unorm';
    const bpp = wide ? 2 : 1;
    const dims: Array<[number, number]> = [
      [frame.width, frame.height],
      [frame.chromaWidth, frame.chromaHeight],
      [frame.chromaWidth, frame.chromaHeight],
    ];
    const out: Plane[] = [];
    for (let i = 0; i < 3; i++) {
      const [w, h] = dims[i];
      const p = this.plane(i, w, h, format);
      const data = frame.planes[i];
      this.device.queue.writeTexture(
        { texture: p.tex },
        data as Uint8Array<ArrayBuffer>,
        { offset: 0, bytesPerRow: w * bpp, rowsPerImage: h },
        { width: w, height: h },
      );
      out.push(p);
    }
    return out as [Plane, Plane, Plane];
  }

  private pass(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline, bind: GPUBindGroup, view: GPUTextureView): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }

  private texBind(pipeline: GPURenderPipeline, ubuf: GPUBuffer, view: GPUTextureView, withSampler = true): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: ubuf } },
      { binding: 2, resource: view },
    ];
    if (withSampler) entries.push({ binding: 1, resource: this.sampler });
    return this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
  }

  render(frame: MediaFrame, settings: RenderSettings): void {
    if (this.destroyed) return;
    const t0 = performance.now();
    const outW = this.canvas.width;
    const outH = this.canvas.height;
    const disp = frameDisplaySize(frame);
    if (!outW || !outH || !disp.width || !disp.height) return;
    const device = this.device;
    const rot = rotationCode(frame.rotation);
    this.frameNo++;

    const A = this.target('A', disp.width, disp.height);
    const encoder = device.createCommandEncoder();
    let packing: ExternalPacking = 'converted';
    let afterSubmit: (() => void) | null = null;
    let peakDetail = '';
    let measured = false;
    const taps = peakTaps(frame.width, frame.height);

    // ---- pass 1: ingest -> A -------------------------------------------------------------
    if (frame.kind === 'planar') {
      const [py, pu, pv] = this.uploadPlanar(frame);
      const yuv = yuvUniforms(frame.color, frame.bitDepth, frame.height);
      const peak = isHdrTransfer(frame.color) ? choosePeak(frame.color, settings, true) : null;
      measured = peak?.source === 'measured';
      peakDetail = peak?.detail ?? '';
      const buf = new ArrayBuffer(128);
      const f = new Float32Array(buf, 0, 28);
      const m = yuv.matrix;
      f.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0], 0);
      f.set([yuv.offset[0], yuv.offset[1], yuv.offset[2], 0], 12);
      f.set([yuv.scale[0], yuv.scale[1], yuv.scale[2], 0], 16);
      f.set([yuv.pack[0], yuv.pack[1], peak?.nits ?? settings.hdrPeak, gamutMapCode(settings.gamutMapping)], 20);
      f.set([measured ? 1 : 0, taps[0], taps[1], 0], 24);
      new Uint32Array(buf, 112, 4).set([transferCode(frame.color), primariesCode(frame.color), toneMapCode(settings.toneMapping), rot]);
      device.queue.writeBuffer(this.uPlanar, 0, buf);
      const source: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.uPlanar } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: py.view },
        { binding: 3, resource: pu.view },
        { binding: 4, resource: pv.view },
      ];
      const step = measured ? this.peak.step(frame, peakKey(frame, '')) : null;
      if (step) this.measurePeak(encoder, this.pMeasurePlanar, source, step);
      const bind = device.createBindGroup({
        layout: this.pPlanar.getBindGroupLayout(0),
        entries: [...source, { binding: 5, resource: this.peakState[this.peakCur].view }],
      });
      this.pass(encoder, this.pPlanar, bind, A.view);
    } else {
      const source = frame.kind === 'videoframe' ? frame.frame : frame.el;
      let ext: GPUExternalTexture;
      try {
        ext = device.importExternalTexture({ source });
      } catch {
        return; // source not ready (e.g. <video> without a decoded frame yet)
      }
      packing = settings.externalHdr ? this.extHdr.packingFor(frame) : 'converted';
      // Only samples that go through our tone curve have a peak to speak of.
      const peak = packing !== 'converted' && isHdrTransfer(frame.color) ? choosePeak(frame.color, settings, true) : null;
      measured = peak?.source === 'measured';
      peakDetail = peak?.detail ?? '';
      const buf = new ArrayBuffer(48);
      new Uint32Array(buf, 0, 8).set([
        packingCode(packing),
        transferCode(frame.color),
        primariesCode(frame.color),
        rot,
        toneMapCode(settings.toneMapping),
        gamutMapCode(settings.gamutMapping),
        measured ? 1 : 0,
      ]);
      new Float32Array(buf, 32, 4).set([peak?.nits ?? settings.hdrPeak, taps[0], taps[1]]);
      device.queue.writeBuffer(this.uExt, 0, buf);
      const from: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.uExt } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: ext },
      ];
      const step = measured ? this.peak.step(frame, peakKey(frame, packing)) : null;
      if (step) this.measurePeak(encoder, this.pMeasureExt, from, step);
      const bind = device.createBindGroup({
        layout: this.pExt.getBindGroupLayout(0),
        entries: [...from, { binding: 3, resource: this.peakState[this.peakCur].view }],
      });
      this.pass(encoder, this.pExt, bind, A.view);
      if (settings.externalHdr && this.extHdr.wantsProbe(frame, t0)) afterSubmit = this.probe(encoder, ext, source, frame, t0);
    }
    let cur: Target = A;

    // ---- pass 2: deband ------------------------------------------------------------------
    if (settings.deband) {
      const B = this.target('B', disp.width, disp.height);
      device.queue.writeBuffer(this.uDeband, 0, new Float32Array([0.016, 18, 0.004, this.frameNo % 4096]));
      this.pass(encoder, this.pDeband, this.texBind(this.pDeband, this.uDeband, cur.view), B.view);
      cur = B;
    }

    // ---- pass 3: scale -------------------------------------------------------------------
    if (settings.scaler !== 'bilinear' || settings.sharpen > 0) {
      const C = this.target('C', outW, outH);
      const upscaling = outW > disp.width || outH > disp.height;
      const useEasu = settings.scaler === 'fsr' && upscaling;
      const kernel = settings.scaler === 'fsr' ? 1 : kernelCode(settings.scaler);
      device.queue.writeBuffer(
        this.uScale,
        0,
        new Float32Array([cur.w, cur.h, outW, outH, kernel, 0.8, settings.linearScaling ? 1 : 0, 0]),
      );
      if (useEasu) this.pass(encoder, this.pEasu, this.texBind(this.pEasu, this.uScale, cur.view, false), C.view);
      else this.pass(encoder, this.pScale, this.texBind(this.pScale, this.uScale, cur.view), C.view);
      cur = C;
    }

    // ---- pass 4: sharpen + dither -> canvas ----------------------------------------------
    device.queue.writeBuffer(this.uFinal, 0, new Float32Array([settings.sharpen, settings.dither ? 1 : 0, this.frameNo % 4096, 0]));
    let view: GPUTextureView;
    try {
      view = this.ctx.getCurrentTexture().createView();
    } catch {
      this.peak.reset(); // the measuring passes of this frame are not going to run
      return;
    }
    this.pass(encoder, this.pFinal, this.texBind(this.pFinal, this.uFinal, cur.view), view);
    device.queue.submit([encoder.finish()]);
    afterSubmit?.();

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

  async readPeak(): Promise<{ peak: number; mean: number } | null> {
    if (this.destroyed || !this.peakLive) return null;
    const device = this.device;
    const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: this.peakState[this.peakCur].tex }, { buffer: buf }, { width: 1, height: 1 });
      device.queue.submit([encoder.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const state = new Float32Array(buf.getMappedRange().slice(0));
      return { peak: pqEotf(state[0]), mean: pqEotf(state[1]) };
    } catch {
      return null;
    } finally {
      buf.destroy();
    }
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
   * Compare what the import returned for this HDR frame with the browser's 2D-canvas rendition of
   * the same pixels (external-hdr.ts). Adds a small pass to `encoder`; the returned function
   * starts the read-back once the commands have been submitted.
   */
  private probe(
    encoder: GPUCommandEncoder,
    ext: GPUExternalTexture,
    source: VideoFrame | HTMLVideoElement,
    frame: MediaFrame,
    now: number,
  ): (() => void) | null {
    const device = this.device;
    const origins = probeOrigins(frame.width, frame.height);
    if (!origins) {
      this.extHdr.giveUp();
      return null;
    }
    const sdr = sampleBrowserSdr(source, origins);
    if (!sdr) {
      this.extHdr.miss(now);
      return null;
    }
    if (!this.probeTex) {
      this.probeTex = device.createTexture({
        label: 'probe',
        size: { width: PROBE_SIZE, height: PROBE_SIZE },
        format: INTERMEDIATE,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      countTexture(this.stats, 1);
      this.probeBuf = device.createBuffer({ size: PROBE_SIZE * PROBE_SIZE * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    const buf = this.probeBuf!;
    device.queue.writeBuffer(this.uProbe, 0, new Float32Array([frame.width, frame.height, PROBE_TILE, 0, ...origins.x, ...origins.y]));
    const bind = device.createBindGroup({
      layout: this.pProbe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uProbe } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: ext },
      ],
    });
    this.pass(encoder, this.pProbe, bind, this.probeTex.createView());
    encoder.copyTextureToBuffer(
      { texture: this.probeTex },
      { buffer: buf, bytesPerRow: PROBE_SIZE * 8, rowsPerImage: PROBE_SIZE },
      { width: PROBE_SIZE, height: PROBE_SIZE },
    );
    const epoch = this.extHdr.epoch;
    return () => {
      this.extHdr.busy = true;
      buf
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const half = new Uint16Array(buf.getMappedRange());
          const rgba = new Float32Array(half.length);
          for (let i = 0; i < half.length; i++) rgba[i] = halfToFloat(half[i]);
          buf.unmap();
          this.extHdr.busy = false;
          if (this.destroyed || epoch !== this.extHdr.epoch) return;
          const changed = this.extHdr.report(frame, classifyExternal(rgba, sdr, frame.color, this.extHdr.candidates()), performance.now());
          this.stats.hdrHandover = this.extHdr.detail;
          // The assumption this frame was drawn with turned out wrong: draw it again.
          if (changed && this.last) this.render(this.last.frame, this.last.settings);
          else if (this.last) this.probeLater(this.last.frame, this.last.settings);
        })
        .catch(() => {
          this.extHdr.busy = false;
        });
    };
  }

  snapshot(): HTMLCanvasElement | null {
    if (!this.last || this.destroyed) return null;
    this.render(this.last.frame, this.last.settings);
    return copyCanvas(this.canvas);
  }

  /** Forget the last frame (the caller is about to close it). */
  forget(): void {
    this.last = null;
    this.extHdr.reset();
    this.peak.reset();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.last = null;
    for (const key of ['A', 'B', 'C'] as const) {
      const t = this.targets[key];
      if (t) {
        t.tex.destroy();
        countTexture(this.stats, -1);
        this.targets[key] = null;
      }
    }
    for (let i = 0; i < 3; i++) {
      const p = this.planes[i];
      if (p) {
        p.tex.destroy();
        countTexture(this.stats, -1);
        this.planes[i] = null;
      }
    }
    clearTimeout(this.probeTimer);
    for (const t of [this.peakGrid, ...this.peakState]) {
      if (t) {
        t.tex.destroy();
        countTexture(this.stats, -1);
      }
    }
    this.peakGrid = null;
    this.peakState = [];
    if (this.probeTex) {
      this.probeTex.destroy();
      countTexture(this.stats, -1);
      this.probeTex = null;
    }
    try {
      this.probeBuf?.destroy();
      this.uProbe?.destroy();
      this.uExt?.destroy();
      this.uPlanar?.destroy();
      this.uReduce?.destroy();
      this.uDeband?.destroy();
      this.uScale?.destroy();
      this.uFinal?.destroy();
      this.ctx?.unconfigure();
      this.device?.destroy();
    } catch {
      /* ignore */
    }
    this.canvas.remove();
  }
}
