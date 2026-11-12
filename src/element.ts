import { Player } from './core/player';
import type { RendererRequest, TierRequest } from './core/types';
import { mountUI, type UIHandle } from './ui';

/**
 * <lumen-player src="…" skin="glass|mpv|studio" tier="auto" renderer="auto" autoplay></lumen-player>
 *
 * Declarative wrapper around Player + mountUI. The element exposes `.player` and `.ui`, so
 * everything the JS API offers stays reachable.
 */
export class LumenPlayerElement extends HTMLElement {
  static observedAttributes = ['src', 'skin'];
  player: Player | null = null;
  ui: UIHandle | null = null;
  private host: HTMLDivElement | null = null;

  connectedCallback(): void {
    if (this.player) return;
    if (!this.style.display) this.style.display = 'block';
    if (!this.style.position) this.style.position = 'relative';
    if (!this.style.aspectRatio && !this.style.height) this.style.aspectRatio = '16 / 9';
    this.host = document.createElement('div');
    this.host.style.cssText = 'position:absolute;inset:0';
    this.appendChild(this.host);
    this.player = new Player({
      container: this.host,
      tier: (this.getAttribute('tier') as TierRequest) ?? 'auto',
      renderer: (this.getAttribute('renderer') as RendererRequest) ?? 'auto',
      fullscreenElement: this,
    });
    this.ui = mountUI(this.player, this.host, { skin: this.getAttribute('skin') ?? undefined });
    const src = this.getAttribute('src');
    if (src) void this.player.load(src, { autoplay: this.hasAttribute('autoplay') }).catch(() => {});
  }

  disconnectedCallback(): void {
    this.ui?.destroy();
    this.ui = null;
    void this.player?.destroy();
    this.player = null;
    this.host?.remove();
    this.host = null;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (!this.player) return;
    if (name === 'src' && value) void this.player.load(value, { autoplay: this.hasAttribute('autoplay') }).catch(() => {});
    if (name === 'skin' && value) this.ui?.setSkin(value);
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('lumen-player')) {
  customElements.define('lumen-player', LumenPlayerElement);
}
