// Tiny DOM builder. Never uses innerHTML: text is always set via text nodes / textContent.

type Child = Node | string | number | null | undefined | false;
type Handler = (ev: Event) => void;
export interface Attrs {
  class?: string | undefined;
  text?: string | undefined;
  on?: Record<string, Handler> | undefined;
  dataset?: Record<string, string> | undefined;
  style?: Record<string, string> | undefined;
  [attr: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, Handler>)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [p, val] of Object.entries(v as Record<string, string>)) el.style.setProperty(p, val);
    else if (k === 'href') {
      const s = String(v);
      // Only same-document hashes, relative paths, or https URLs.
      if (/^(#|\.\/|https:\/\/)/.test(s)) el.setAttribute('href', s);
    } else if (/^on/i.test(k)) continue; // never allow inline event handler attributes
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(sel);
}

/** Safe external link: only whitelisted origins; opens in a new tab with noopener/noreferrer. */
const SAFE_EXTERNAL = /^https:\/\/(www\.cdc\.gov\.tw|www\.nhi\.gov\.tw|github\.com\/ancientsky\/denguemap|cdcdengue\.azurewebsites\.net|data\.gov\.tw|openfreemap\.org|www\.openstreetmap\.org|openmaptiles\.org|maplibre\.org)(\/|$)/;
export function extLink(url: string, label: string, cls = 'ext'): HTMLElement {
  if (!SAFE_EXTERNAL.test(url)) return h('span', { class: cls }, label);
  const a = h('a', { class: cls, href: url, target: '_blank', rel: 'noopener noreferrer' }, label);
  return a;
}

let uid = 0;
export const nextId = (prefix = 'id'): string => `${prefix}-${++uid}`;

/** rAF-coalesced callback: many calls per frame → one invocation with the latest args. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let queued = false;
  let last: A;
  return (...args: A) => {
    last = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...last);
    });
  };
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const prefersReducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
