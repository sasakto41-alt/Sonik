/**
 * UI-утилиты: создание элементов, модальные окна, подтверждения, тосты,
 * виртуальные слайдеры и форматирование.
 */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number | boolean | undefined | null | ((e: Event) => void)>,
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false || v === null) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k === 'html') {
        el.innerHTML = String(v);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function el<T extends HTMLElement>(sel: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`Элемент не найден: ${sel}`);
  return found;
}

// ─── Тосты ───

export function toast(level: 'info' | 'success' | 'error', message: string, timeout = 4200): void {
  const root = document.getElementById('toasts');
  if (!root) return;
  const t = h('div', { class: `toast ${level}` },
    h('span', { class: 'toast-icon', html: level === 'error' ? ICONS.alert : level === 'success' ? ICONS.check : ICONS.info }),
    h('span', { class: 'toast-text' }, message));
  root.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  window.setTimeout(() => {
    t.classList.remove('show');
    window.setTimeout(() => t.remove(), 350);
  }, timeout);
}

// ─── Модальные окна ───

export interface ModalHandle { close(): void; body: HTMLElement }

const modalStack: ModalHandle[] = [];

export function modal(title: string, build: (body: HTMLElement, close: () => void) => void, opts: { wide?: boolean } = {}): ModalHandle {
  const root = document.getElementById('modal-root')!;
  const overlay = h('div', { class: 'modal-overlay' });
  const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : '') });
  const head = h('div', { class: 'modal-head' },
    h('div', { class: 'modal-title' }, title),
    h('button', { class: 'icon-btn', html: ICONS.close, title: 'Закрыть (Esc)', onclick: () => close() }));
  const body = h('div', { class: 'modal-body' }) as HTMLElement;
  box.append(head, body);
  overlay.append(box);
  root.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));

  const handle: ModalHandle = {
    body,
    close: () => {
      overlay.classList.remove('show');
      const i = modalStack.indexOf(handle);
      if (i >= 0) modalStack.splice(i, 1);
      window.setTimeout(() => overlay.remove(), 220);
    }
  };
  modalStack.push(handle);
  build(body, handle.close);
  return handle;
}

export function closeTopModal(): boolean {
  const m = modalStack[modalStack.length - 1];
  if (m) { m.close(); return true; }
  return false;
}

export function confirmDialog(title: string, text: string, okLabel = 'Подтвердить', danger = false): Promise<boolean> {
  return new Promise(resolve => {
    const m = modal(title, (body, close) => {
      body.append(h('p', { class: 'confirm-text' }, text));
      const row = h('div', { class: 'btn-row end' },
        h('button', { class: 'btn ghost', onclick: () => { close(); resolve(false); } }, 'Отмена'),
        h('button', { class: 'btn' + (danger ? ' danger' : ''), onclick: () => { close(); resolve(true); } }, okLabel));
      body.append(row);
    });
    void m;
  });
}

export function promptDialog(title: string, text: string, initial = ''): Promise<string | null> {
  return new Promise(resolve => {
    const m = modal(title, (body, close) => {
      const input = h('input', { class: 'input', value: initial, placeholder: text }) as HTMLInputElement;
      body.append(input);
      const submit = () => { const v = input.value.trim(); close(); resolve(v || null); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
      body.append(h('div', { class: 'btn-row end' },
        h('button', { class: 'btn ghost', onclick: () => { close(); resolve(null); } }, 'Отмена'),
        h('button', { class: 'btn', onclick: submit }, 'Сохранить')));
      window.setTimeout(() => input.focus(), 50);
    });
    void m;
  });
}

// ─── Прочее ───

export function spinner(): HTMLElement {
  return h('div', { class: 'spinner-wrap' }, h('div', { class: 'spinner' }));
}

export function emptyState(icon: string, title: string, hint?: string, action?: { label: string; onClick: () => void }): HTMLElement {
  const box = h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon', html: icon }),
    h('div', { class: 'empty-title' }, title));
  if (hint) box.append(h('div', { class: 'empty-hint' }, hint));
  if (action) box.append(h('button', { class: 'btn accent', onclick: action.onClick }, action.label));
  return box;
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const hh = Math.floor(sec / 3600);
  const mm = hh > 0 ? String(m).padStart(2, '0') : String(m);
  return (hh > 0 ? hh + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

export function fmtBytes(n: number): string {
  if (!n) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDate(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Слайдер с прогрессом: клик/перетаскивание по полосе. */
export function makeSlider(opts: {
  value: number; max: number; onInput?: (v: number) => void; onChange?: (v: number) => void;
  vertical?: boolean; class?: string;
}): { root: HTMLElement; setValue(v: number, silent?: boolean): void; setMax(v: number): void } {
  let value = opts.value;
  let max = opts.max;
  const fill = h('div', { class: 'slider-fill' });
  const root = h('div', { class: 'slider' + (opts.vertical ? ' vertical' : '') + (opts.class ? ' ' + opts.class : '') }, fill);

  const apply = (): void => {
    const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
    fill.style.width = pct + '%';
    fill.style.height = pct + '%';
  };
  apply();

  const posToValue = (e: PointerEvent): number => {
    const rect = root.getBoundingClientRect();
    let k: number;
    if (opts.vertical) k = 1 - (e.clientY - rect.top) / rect.height;
    else k = (e.clientX - rect.left) / rect.width;
    k = Math.min(1, Math.max(0, k));
    return k * max;
  };

  let dragging = false;
  root.addEventListener('pointerdown', (e) => {
    dragging = true;
    root.classList.add('dragging');
    root.setPointerCapture(e.pointerId);
    value = posToValue(e);
    apply();
    opts.onInput?.(value);
  });
  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    value = posToValue(e);
    apply();
    opts.onInput?.(value);
  });
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('dragging');
    value = posToValue(e);
    apply();
    opts.onChange?.(value);
    opts.onInput?.(value);
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  return {
    root,
    setValue(v: number, silent = false): void {
      if (!dragging) {
        value = v;
        apply();
        if (!silent) opts.onInput?.(value);
      }
    },
    setMax(v: number): void {
      if (v > 0 && isFinite(v)) max = v;
      apply();
    }
  };
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: number | null = null;
  return (...args: A) => {
    if (t !== null) window.clearTimeout(t);
    t = window.setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

// Иконки импортируются внизу, чтобы избежать циклической зависимости в рантайме
import { ICONS } from './icons';
