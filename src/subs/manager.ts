import JASSUB from 'jassub';
import defaultFontUrl from 'jassub/dist/default.woff2?url';
import type { SubtitleTrackInfo } from '../core/types';
import { chunk, DEFAULT_ASS_HEADER, markupToAss, parseSrt, parseVtt, sniffTextFormat, type ChunkEvent } from './convert';
import { isFontAttachment, scanMatroska, type MkvSubtitleTrack } from './mkv';
import { PgsRenderer, PgsStream } from './pgs';

interface Track {
  info: SubtitleTrackInfo;
  kind: 'ass' | 'pgs';
  /** Complete script (external .ass files). */
  fullText?: string;
  /** Header + streamed chunk events (Matroska tracks, converted SRT/VTT). */
  header?: string;
  events: ChunkEvent[];
  /** How many of `events` libass already has. */
  sent: number;
  pgs?: PgsStream;
  mkvNumber?: number;
  mkvCodec?: string;
  isDefault?: boolean;
}

const utf8 = new TextDecoder('utf-8');

/**
 * libass' fallback face. JASSUB would fetch it lazily the first time a glyph needs it, which
 * leaves a paused frame blank until something else triggers a repaint; loading it up front means
 * the very first draw already has a usable font.
 */
let fallbackFont: Promise<Uint8Array | null> | null = null;
function loadFallbackFont(): Promise<Uint8Array | null> {
  fallbackFont ??= fetch(defaultFontUrl)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((b) => new Uint8Array(b))
    .catch(() => null);
  return fallbackFont;
}

function ensureEventsSection(header: string): string {
  let h = header.replace(/\0+$/, '').replace(/\r\n/g, '\n');
  if (!/\[Events\]/i.test(h)) {
    h = h.trimEnd() + '\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  } else if (!/\[Events\][^\[]*Format:/i.test(h)) {
    h = h.trimEnd() + '\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  }
  return h.endsWith('\n') ? h : h + '\n';
}

/**
 * Owns every subtitle track and the two overlay canvases:
 *   - ASS/SSA, and SRT/WebVTT converted to ASS, are rendered by libass (JASSUB, WASM in a worker
 *     drawing to an OffscreenCanvas). We drive it in "manual" mode with the player's own clock, so
 *     each video frame is rendered with the subtitle state for exactly that frame's timestamp.
 *   - PGS bitmap tracks are decoded and composited by our own renderer.
 * Fonts attached to a Matroska file are handed to libass before the first event is rendered.
 */
export class SubtitleManager {
  private tracks = new Map<number, Track>();
  private nextId = 1;
  private active = -1;
  private visible = true;
  private delay = 0;
  private jassub: JASSUB | null = null;
  private jassubCanvas: HTMLCanvasElement | null = null;
  private pgs: PgsRenderer | null = null;
  private fonts: Uint8Array[] = [];
  private fontNames: string[] = [];
  private fontsSent = 0;
  private ops: Promise<void> = Promise.resolve();
  private last = { time: 0, width: 0, height: 0 };
  private scanAbort: AbortController | null = null;
  private destroyed = false;
  private rect = { left: 0, top: 0, width: 0, height: 0 };
  private renders = 0;
  private completed = 0;
  private busySkips = 0;
  private autoSelect = true;
  private settleRaf = 0;
  private settleTimers: number[] = [];
  /** Fired whenever the track list or selection changes. */
  onChange: () => void = () => {};
  onError: (message: string) => void = () => {};

  constructor(private stage: HTMLElement) {}

  // ---- public state ---------------------------------------------------------------------------

  list(): SubtitleTrackInfo[] {
    return [...this.tracks.values()].map((t) => t.info);
  }

  get activeId(): number {
    return this.active;
  }

  get loadedFonts(): string[] {
    return [...this.fontNames];
  }

  get debug() {
    const t = this.tracks.get(this.active);
    return {
      engine: t ? (t.kind === 'pgs' ? 'pgs (canvas 2d)' : 'libass (JASSUB wasm)') : 'none',
      events: t ? (t.kind === 'pgs' ? (t.pgs?.events.length ?? 0) : t.fullText ? -1 : t.events.length) : 0,
      fonts: this.fontNames,
      renders: this.renders,
      /** libass frames actually drawn / requests that arrived while the previous frame was still rendering */
      completed: this.completed,
      busySkips: this.busySkips,
      ready: !!this.jassub || t?.kind === 'pgs',
    };
  }

  /** Resolves when all queued track operations have been applied. */
  settled(): Promise<void> {
    return this.ops;
  }

  // ---- adding tracks --------------------------------------------------------------------------

  private register(t: Omit<Track, 'info' | 'sent'> & { info: Omit<SubtitleTrackInfo, 'id'> }): Track {
    const id = this.nextId++;
    const track: Track = { ...t, info: { ...t.info, id }, sent: 0 };
    this.tracks.set(id, track);
    this.onChange();
    return track;
  }

  /** Add a subtitle file the user supplied. Returns the new track id (or -1 if unrecognised). */
  addExternal(name: string, data: string | Uint8Array, select = true): number {
    const lower = name.toLowerCase();
    let track: Track | null = null;
    if (lower.endsWith('.sup') || (data instanceof Uint8Array && data[0] === 0x50 && data[1] === 0x47)) {
      const pgs = new PgsStream();
      pgs.feedSup(data instanceof Uint8Array ? data : new TextEncoder().encode(data));
      track = this.register({ kind: 'pgs', pgs, events: [], info: { label: name, language: 'und', codec: 'pgs', external: true } });
    } else {
      const text = typeof data === 'string' ? data : utf8.decode(data);
      const fmt = sniffTextFormat(name, text);
      if (!fmt) {
        this.onError(`Unrecognised subtitle format: ${name}`);
        return -1;
      }
      if (fmt === 'ass') {
        track = this.register({
          kind: 'ass',
          fullText: text,
          events: [],
          info: { label: name, language: 'und', codec: 'ass', external: true },
        });
      } else {
        const events = fmt === 'srt' ? parseSrt(text) : parseVtt(text);
        track = this.register({
          kind: 'ass',
          header: DEFAULT_ASS_HEADER,
          events,
          info: { label: name, language: 'und', codec: fmt, external: true },
        });
      }
    }
    if (select) void this.select(track.info.id);
    return track.info.id;
  }

  /** Scan a Matroska blob for embedded subtitle tracks and font attachments (runs in the background). */
  attachContainer(blob: Blob): Promise<void> {
    this.scanAbort?.abort();
    const ac = new AbortController();
    this.scanAbort = ac;
    const byNumber = new Map<number, Track>();
    let order = 0;
    return scanMatroska(blob, {
      signal: ac.signal,
      onTracks: (list: MkvSubtitleTrack[]) => {
        for (const m of list) {
          const codec = m.codecId;
          const label = m.name || `${m.language} (${codec.replace(/^S_(TEXT\/)?/, '').toLowerCase()})`;
          let track: Track | null = null;
          if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA' || codec === 'S_ASS' || codec === 'S_SSA') {
            const header = ensureEventsSection(m.codecPrivate ? utf8.decode(m.codecPrivate) : DEFAULT_ASS_HEADER);
            track = this.register({
              kind: 'ass',
              header,
              events: [],
              info: { label, language: m.language, codec: 'ass', external: false },
            });
          } else if (codec === 'S_TEXT/UTF8' || codec === 'S_TEXT/ASCII') {
            track = this.register({
              kind: 'ass',
              header: DEFAULT_ASS_HEADER,
              events: [],
              info: { label, language: m.language, codec: 'srt', external: false },
            });
          } else if (codec === 'S_TEXT/WEBVTT' || codec === 'D_WEBVTT/SUBTITLES') {
            track = this.register({
              kind: 'ass',
              header: DEFAULT_ASS_HEADER,
              events: [],
              info: { label, language: m.language, codec: 'vtt', external: false },
            });
          } else if (codec === 'S_HDMV/PGS') {
            track = this.register({
              kind: 'pgs',
              pgs: new PgsStream(),
              events: [],
              info: { label, language: m.language, codec: 'pgs', external: false },
            });
          }
          if (track) {
            track.mkvNumber = m.number;
            track.mkvCodec = codec;
            track.isDefault = m.isDefault;
            byNumber.set(m.number, track);
          }
        }
        // Auto-select the first default (or first) embedded track, like mpv does.
        if (this.autoSelect && this.active < 0 && byNumber.size) {
          const pick = [...byNumber.values()].find((t) => t.isDefault) ?? [...byNumber.values()][0];
          void this.select(pick.info.id);
        }
      },
      onAttachment: (a) => {
        if (!isFontAttachment(a)) return;
        this.fonts.push(a.data);
        this.fontNames.push(a.name);
        this.queue(async () => {
          if (this.jassub) await this.flushFonts();
        });
      },
      onCue: (cue) => {
        const track = byNumber.get(cue.track);
        if (!track) return;
        if (track.kind === 'pgs') {
          track.pgs!.feedBlock(cue.data, cue.start / 1000);
          return;
        }
        let text = utf8.decode(cue.data);
        if (track.info.codec !== 'ass') text = chunk(order++, markupToAss(text));
        track.events.push({ start: cue.start, duration: cue.duration || 5000, text });
        if (track.info.id === this.active) this.queue(() => this.flushEvents(track));
      },
    })
      .then(() => {
        if (!ac.signal.aborted) this.rerender(true);
      })
      .catch((err) => {
        if (!ac.signal.aborted) this.onError(`Subtitle scan failed: ${err?.message ?? err}`);
      });
  }

  /** Provide extra fonts (e.g. user supplied) for libass. */
  addFont(name: string, data: Uint8Array): void {
    this.fonts.push(data);
    this.fontNames.push(name);
    this.queue(async () => {
      if (this.jassub) await this.flushFonts();
    });
  }

  // ---- selection & rendering ------------------------------------------------------------------

  private queue(fn: () => Promise<void> | void): Promise<void> {
    this.ops = this.ops
      .then(() => (this.destroyed ? undefined : fn()))
      .catch((err) => this.onError(`Subtitle engine: ${err?.message ?? err}`));
    return this.ops;
  }

  select(id: number): Promise<void> {
    this.autoSelect = false;
    this.active = this.tracks.has(id) ? id : -1;
    this.onChange();
    return this.queue(async () => {
      const t = this.tracks.get(this.active);
      if (!t) {
        this.applyVisibility();
        return;
      }
      if (t.kind === 'pgs') {
        if (!this.pgs) {
          this.pgs = new PgsRenderer();
          this.stage.appendChild(this.pgs.canvas);
          this.applyRect();
        }
        this.pgs.setStream(t.pgs!);
      } else {
        const content = t.fullText ?? t.header ?? DEFAULT_ASS_HEADER;
        if (!this.jassub) {
          const canvas = document.createElement('canvas');
          canvas.className = 'lp-sub-canvas lp-sub-ass';
          this.stage.appendChild(canvas);
          this.jassubCanvas = canvas;
          this.applyRect();
          const fallback = await loadFallbackFont();
          if (this.destroyed || this.jassubCanvas !== canvas) return;
          // Embedded fonts first so they win name lookups; the fallback face is always present.
          this.jassub = new JASSUB({
            canvas,
            subContent: content,
            fonts: [...this.fonts, ...(fallback ? [fallback.slice()] : [])],
            queryFonts: 'local',
          });
          this.fontsSent = this.fonts.length;
          await this.jassub.ready;
        } else {
          await this.flushFonts();
          await this.jassub.renderer.setTrack(content);
        }
        t.sent = 0;
        await this.flushEvents(t);
      }
      this.applyVisibility();
      this.rerender(true);
    });
  }

  private async flushFonts(): Promise<void> {
    if (!this.jassub || this.fontsSent >= this.fonts.length) return;
    const fresh = this.fonts.slice(this.fontsSent);
    this.fontsSent = this.fonts.length;
    await this.jassub.renderer.addFonts(fresh);
  }

  private async flushEvents(t: Track): Promise<void> {
    if (!this.jassub || t.fullText || t.info.id !== this.active) return;
    let lastCall: unknown = null;
    while (t.sent < t.events.length) {
      const ev = t.events[t.sent++];
      lastCall = this.jassub.renderer.processChunk(ev.text, Math.round(ev.start), Math.round(ev.duration));
    }
    if (lastCall) await lastCall;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.applyVisibility();
    if (v) this.rerender(true);
  }

  setDelay(seconds: number): void {
    this.delay = seconds;
    this.rerender(true);
  }

  private applyVisibility(): void {
    const t = this.tracks.get(this.active);
    const show = this.visible && !!t;
    if (this.jassubCanvas) this.jassubCanvas.style.display = show && t!.kind === 'ass' ? '' : 'none';
    if (this.pgs) this.pgs.canvas.style.display = show && t!.kind === 'pgs' ? '' : 'none';
  }

  /** Position the overlays exactly over the displayed video rectangle (CSS pixels within the stage). */
  layout(rect: { left: number; top: number; width: number; height: number }): void {
    this.rect = rect;
    this.applyRect();
  }

  private applyRect(): void {
    for (const c of [this.jassubCanvas, this.pgs?.canvas]) {
      if (!c) continue;
      c.style.left = `${this.rect.left}px`;
      c.style.top = `${this.rect.top}px`;
      c.style.width = `${this.rect.width}px`;
      c.style.height = `${this.rect.height}px`;
    }
  }

  /**
   * Render subtitles for media time `time` (seconds). Cheap to call every animation frame.
   *
   * `settle` must be true when no further render is going to follow on its own (paused, frame
   * stepping, a resize): the OffscreenCanvas a worker draws into only reliably reaches the screen
   * once a later frame is submitted — in particular the first draw after the overlay is created
   * or resized is otherwise lost — so two confirming repaints are issued on the next frames.
   */
  render(time: number, width: number, height: number, force = false, settle = false): void {
    this.last = { time, width, height };
    this.cancelSettle();
    this.draw(force);
    if (settle && !this.destroyed) {
      let n = 0;
      const again = () => {
        if (this.destroyed) return;
        this.draw(true);
        if (++n < 2) this.settleRaf = requestAnimationFrame(again);
      };
      this.settleRaf = requestAnimationFrame(again);
      // A font that libass had to fetch or look up asynchronously arrives a little later; its
      // repaint needs the same confirmation, so check back a few more times while nothing moves.
      for (const ms of [120, 350, 900, 2000]) {
        this.settleTimers.push(window.setTimeout(() => !this.destroyed && this.draw(true), ms));
      }
    }
  }

  private cancelSettle(): void {
    cancelAnimationFrame(this.settleRaf);
    for (const t of this.settleTimers) clearTimeout(t);
    this.settleTimers.length = 0;
  }

  private draw(force: boolean): void {
    const { time, width, height } = this.last;
    if (!this.visible || this.destroyed) return;
    const t = this.tracks.get(this.active);
    if (!t || !width || !height) return;
    // +0.5 ms guards against float rounding putting an event one millisecond tick late.
    const at = time - this.delay + 0.0005;
    if (t.kind === 'pgs') {
      this.pgs?.draw(at, force);
      this.renders++;
    } else if (this.jassub?.renderer) {
      this.renders++;
      if (this.jassub.busy) this.busySkips++;
      this.jassub
        .manualRender({ expectedDisplayTime: performance.now(), width, height, mediaTime: Math.max(0, at) }, force)
        .then(() => this.completed++)
        .catch(() => {});
    }
  }

  private rerender(force: boolean): void {
    if (this.last.width) this.render(this.last.time, this.last.width, this.last.height, force, true);
  }

  /** The canvas currently showing subtitles (for screenshots and tests). */
  activeCanvas(): HTMLCanvasElement | null {
    const t = this.tracks.get(this.active);
    if (!t || !this.visible) return null;
    return t.kind === 'pgs' ? (this.pgs?.canvas ?? null) : this.jassubCanvas;
  }

  /** Remove every track (new file loaded). */
  reset(): void {
    this.scanAbort?.abort();
    this.scanAbort = null;
    this.cancelSettle();
    this.tracks.clear();
    this.active = -1;
    this.autoSelect = true;
    this.fonts = [];
    this.fontNames = [];
    this.fontsSent = 0;
    const j = this.jassub;
    this.jassub = null;
    this.jassubCanvas = null;
    this.ops = this.ops.then(() => j?.destroy()).catch(() => {});
    this.pgs?.destroy();
    this.pgs = null;
    this.onChange();
  }

  async destroy(): Promise<void> {
    this.reset();
    this.destroyed = true;
    await this.ops.catch(() => {});
  }
}
