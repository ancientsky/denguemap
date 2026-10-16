// localStorage access that never throws (private mode / blocked storage).
export function getPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export type Listener<T> = (v: T) => void;
export class Emitter<T> {
  private ls = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.ls.add(fn);
    return () => this.ls.delete(fn);
  }
  emit(v: T): void {
    for (const fn of [...this.ls]) fn(v);
  }
}
