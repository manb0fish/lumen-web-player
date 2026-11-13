/**
 * Library entry point.
 *
 *   import { Player, mountUI } from 'lumen-player';
 *   const player = new Player({ container });      // headless core
 *   const ui = mountUI(player, container);         // optional skinnable UI
 *   await player.load(fileOrUrl, { autoplay: true });
 *
 * or simply  <lumen-player src="movie.mkv" skin="glass" autoplay></lumen-player>
 */
export { Player, type PlayerOptions, type LoadOptions, type PlayerEvents, type PlayerPlugin, type PlayerStats } from './core/player';
export { Store, Emitter } from './core/store';
export { CommandBus, type PropertyDef } from './core/commands';
export { KeyBindings, DEFAULT_INPUT_CONF, parseInputConf } from './core/keybindings';
export * from './core/types';
export { detectCapabilities, type Capabilities, type WasmMode } from './pipeline/router';
export {
  mountUI,
  registerControl,
  BUILTIN_SKINS,
  SkinEngine,
  validateSkin,
  type UIHandle,
  type UIOptions,
  type SkinManifest,
  type LayoutItem,
  type ControlContext,
  type ControlFactory,
} from './ui';
export { LumenPlayerElement } from './element';
export { ensureCrossOriginIsolation, type IsolationResult } from './isolate';
