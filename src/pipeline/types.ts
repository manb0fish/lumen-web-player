import type { MediaFrame } from '../core/types';

export interface PipelineStats {
  /** Frames handed to the renderer. */
  presented: number;
  /** Frames skipped because a newer one was already due. */
  dropped: number;
  /** Frames shown more than one frame-duration late. */
  delayed: number;
  /** Presentation rate over the last second. */
  fps: number;
  /** Decoded frames waiting for their presentation time. */
  queue: number;
  /** Seconds of decoded video / audio ahead of the playhead. */
  videoAhead: number;
  audioAhead: number;
  /** Clock minus PTS of the last presented frame, i.e. how late the picture is vs. audio. */
  driftMs: number;
  driftAvgMs: number;
  driftMaxMs: number;
  decodeLatencyMs: number;
  underruns: number;
  /** VideoFrames currently open on the main thread (must return to 0 after teardown). */
  framesAlive: number;
  hold: string | null;
  lastPts: number;
  notes: string[];
}

export interface PipelineCallbacks {
  onState(patch: { paused?: boolean; buffering?: boolean; ended?: boolean; seeking?: boolean }): void;
  onError(message: string, kind: string): void;
  onNote(message: string): void;
  /** Draw this frame now. The pipeline keeps it alive until the next present() or forget(). */
  present(frame: MediaFrame): void;
  /** The pipeline is about to close the frame it last presented. */
  forget(): void;
  /** Called once per display refresh, after any frame for that refresh has been presented. */
  onRefresh?(): void;
}

export interface Pipeline {
  readonly kind: 'frames' | 'element';
  readonly element: HTMLVideoElement | null;
  play(): Promise<void>;
  pause(): void;
  seek(time: number, exact: boolean): void;
  setRate(rate: number): void;
  setPitchCorrection(on: boolean): void;
  frameStep(direction: 1 | -1): void;
  currentTime(): number;
  stats(): PipelineStats;
  destroy(): Promise<void>;
}

/** Global VideoFrame accounting, so tests can assert that every frame that reached the page was closed. */
export const frameLedger = { opened: 0, closed: 0 };

export function emptyStats(): PipelineStats {
  return {
    presented: 0,
    dropped: 0,
    delayed: 0,
    fps: 0,
    queue: 0,
    videoAhead: 0,
    audioAhead: 0,
    driftMs: 0,
    driftAvgMs: 0,
    driftMaxMs: 0,
    decodeLatencyMs: 0,
    underruns: 0,
    framesAlive: 0,
    hold: null,
    lastPts: 0,
    notes: [],
  };
}
