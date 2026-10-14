/**
 * API-клиент: fetch к внутреннему локальному серверу.
 * Приложение полностью локальное — токены и PIN не нужны.
 * Команда считается выполненной только после ответа сервера.
 */

export const URL_PARAMS = new URLSearchParams(location.search);
/** База API: пусто = тот же origin; в dev-режиме задаётся параметром ?api= */
export const API_BASE = URL_PARAMS.get('api') || '';

export function isElectron(): boolean {
  return Boolean((window as { sonicDesktop?: unknown }).sonicDesktop);
}

export function mediaUrl(p: string): string {
  return API_BASE + p;
}

export function wsUrl(): string {
  const base = API_BASE || (location.protocol === 'https:' ? 'wss://' + location.host : 'ws://' + location.host);
  return base.replace(/^http/, 'ws') + '/ws';
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public data?: unknown) {
    super(message);
  }
}

type ToastFn = (level: 'info' | 'success' | 'error', message: string) => void;
let toastHandler: ToastFn = () => {};
export function setToastHandler(fn: ToastFn): void { toastHandler = fn; }

async function request<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (raw) {
      payload = body as BodyInit;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: payload });
  } catch {
    // Тихо: индикатор-точка в шапке покажет состояние, тостов «Нет соединения» больше нет
    throw new ApiError(0, 'Внутренний сбой, повторите попытку');
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = (data as { error?: string; code?: string }) || {};
    const message = err.error || `Ошибка (${res.status})`;
    // Сбои типа 0/5xx показываем как тихую ошибку без тоста — только существенные
    if (res.status >= 400 && res.status < 500) toastHandler('error', message);
    throw new ApiError(res.status, message, err.code, data);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, body?: unknown) => request<T>('POST', p, body),
  postRaw: <T>(p: string, body: ArrayBuffer | Blob | BufferSource) => request<T>('POST', p, body, true),
  put: <T>(p: string, body?: unknown) => request<T>('PUT', p, body),
  del: <T>(p: string) => request<T>('DELETE', p)
};
