export interface MenuItem {
  type?: 'item' | 'header' | 'separator';
  label?: string;
  hint?: string;
  checked?: boolean;
  /** Keep the menu open (and rebuild it) after selecting — for toggles. */
  keepOpen?: boolean;
  /** Replace the menu's contents with another list (a "Back" entry is added on top). */
  submenu?: () => MenuItem[];
  onSelect?: () => void;
}

let closeCurrent: (() => void) | null = null;

export function closeMenu(): void {
  closeCurrent?.();
}

export function isMenuOpen(): boolean {
  return closeCurrent !== null;
}

/**
 * Open a popover menu anchored above (or below) `anchor`, inside the player root. On a compact
 * player the stylesheet turns it into a sheet along the bottom edge instead.
 */
export function openMenu(root: HTMLElement, anchor: HTMLElement, build: () => MenuItem[]): void {
  const reopening = closeCurrent && (anchor as any).__lpMenuOpen;
  closeMenu();
  if (reopening) return; // second click on the same button just closes

  const overlay = root.querySelector('.lp-overlay') as HTMLElement;
  const menu = document.createElement('div');
  menu.className = 'lp-menu';
  menu.setAttribute('role', 'menu');
  menu.dataset.lpChrome = '';
  menu.dataset.lpScroll = '';

  // The list being shown; submenus push onto it and "Back" pops.
  const stack: Array<() => MenuItem[]> = [build];

  const render = () => {
    menu.textContent = '';
    const items = stack[stack.length - 1]();
    if (stack.length > 1) {
      items.unshift(
        {
          label: '‹  Back',
          keepOpen: true,
          onSelect: () => {
            stack.pop();
          },
        },
        { type: 'separator' },
      );
    }
    for (const item of items) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'lp-menu-sep';
        menu.appendChild(sep);
        continue;
      }
      if (item.type === 'header') {
        const h = document.createElement('div');
        h.className = 'lp-menu-header';
        h.textContent = item.label ?? '';
        menu.appendChild(h);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lp-menu-item';
      b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
      if (item.checked !== undefined) b.dataset.checked = String(item.checked);
      const check = document.createElement('span');
      check.className = 'lp-menu-check';
      check.textContent = item.checked ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'lp-menu-label';
      label.textContent = item.label ?? '';
      b.append(check, label);
      const hintText = item.hint ?? (item.submenu ? '›' : '');
      if (hintText) {
        const hint = document.createElement('span');
        hint.className = 'lp-menu-hint';
        hint.textContent = hintText;
        b.appendChild(hint);
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        item.onSelect?.();
        if (item.submenu) stack.push(item.submenu);
        if (item.submenu || item.keepOpen) {
          queueMicrotask(() => {
            render();
            place();
          });
        } else closeMenu();
      });
      menu.appendChild(b);
    }
  };

  const place = () => {
    const r = root.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = a.right - r.left - mw;
    if (left < 8) left = Math.min(a.left - r.left, r.width - mw - 8);
    left = Math.max(8, Math.min(left, r.width - mw - 8));
    const above = a.top - r.top - 8;
    const below = r.bottom - a.bottom - 8;
    if (above >= mh || above >= below) {
      menu.style.bottom = `${r.bottom - a.top + 8}px`;
      menu.style.top = '';
    } else {
      menu.style.top = `${a.bottom - r.top + 8}px`;
      menu.style.bottom = '';
    }
    menu.style.left = `${left}px`;
  };

  render();
  overlay.appendChild(menu);
  place();

  const onDown = (e: Event) => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
    }
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeMenu);
  (anchor as any).__lpMenuOpen = true;
  anchor.setAttribute('aria-expanded', 'true');
  closeCurrent = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeMenu);
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    // Clear the flag on the next tick so the click that closed the menu does not reopen it.
    setTimeout(() => ((anchor as any).__lpMenuOpen = false), 0);
    closeCurrent = null;
  };
}
