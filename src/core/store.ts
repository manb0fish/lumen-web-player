/** Minimal typed event emitter and a batched reactive state store. Zero dependencies. */

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, any>> {
  private map = new Map<keyof Events, Set<Listener<any>>>();

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  once<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[lumen] listener for "${String(type)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}

export type StoreListener<S> = (state: Readonly<S>, changed: ReadonlySet<keyof S>) => void;

/**
 * Reactive store. `set()` is synchronous for readers (state is updated immediately) but listeners
 * are notified once per microtask with the union of changed keys, so a burst of updates from the
 * render loop costs a single UI pass.
 */
export class Store<S extends object> {
  private listeners = new Set<StoreListener<S>>();
  private pending = new Set<keyof S>();
  private scheduled = false;
  state: S;

  constructor(initial: S) {
    this.state = { ...initial };
  }

  get<K extends keyof S>(key: K): S[K] {
    return this.state[key];
  }

  set(patch: Partial<S>): void {
    let dirty = false;
    for (const k in patch) {
      const v = patch[k] as S[typeof k];
      if (!Object.is(this.state[k], v)) {
        this.state[k] = v;
        this.pending.add(k);
        dirty = true;
      }
    }
    if (dirty && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    if (this.pending.size === 0) return;
    const changed = this.pending;
    this.pending = new Set();
    for (const fn of [...this.listeners]) {
      try {
        fn(this.state, changed);
      } catch (err) {
        console.error('[lumen] store listener threw', err);
      }
    }
  }

  /** Subscribe to every change. Returns an unsubscribe function. */
  subscribe(fn: StoreListener<S>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to specific keys; `fn` is called immediately with the current state. */
  watch<K extends keyof S>(keys: K[], fn: (state: Readonly<S>) => void): () => void {
    const off = this.subscribe((state, changed) => {
      for (const k of keys) {
        if (changed.has(k)) {
          fn(state);
          return;
        }
      }
    });
    fn(this.state);
    return off;
  }
}
