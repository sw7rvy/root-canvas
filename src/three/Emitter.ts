export type Unsubscribe = () => void;

export class Emitter<Events> {
  private channels = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): Unsubscribe {
    let set = this.channels.get(type);
    if (!set) {
      set = new Set();
      this.channels.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => this.off(type, handler);
  }

  once<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): Unsubscribe {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): void {
    const set = this.channels.get(type);
    if (!set) return;
    set.delete(handler as (payload: never) => void);
    if (set.size === 0) this.channels.delete(type);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.channels.get(type);
    if (!set) return;
    for (const handler of [...set]) (handler as (p: Events[K]) => void)(payload);
  }

  has<K extends keyof Events>(type: K): boolean {
    return (this.channels.get(type)?.size ?? 0) > 0;
  }

  clear(): void {
    this.channels.clear();
  }
}
