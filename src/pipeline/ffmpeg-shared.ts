/** Layout of the SharedArrayBuffer control block shared by the FFmpeg worker and its client. */
export const CTRL_GEN = 0; // generation the main thread currently wants
export const CTRL_CLOCK_MS = 1; // media clock in milliseconds
export const CTRL_RELEASED = 2; // video frames consumed by the main thread in this generation
export const CTRL_MSE_GATE = 3; // 1 = MSE wants more bytes, 0 = hold
export const CTRL_LENGTH = 8;
