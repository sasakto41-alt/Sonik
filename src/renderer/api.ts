/**
 * API-клиент: fetch с токеном авторизации (для LAN), понятные ошибки.
 * Команда считается выполненной только после ответа сервера.
 */

export const URL_PARAMS = new URLSearchParams(location.search);
/** База API: пусто = тот же origin; в dev-режиме задаётся параметром ?api= */
export const API_BASE = URL_PARAMS.get('api') || '';

export function getToken(): string {
  return localStorage.getItem('sonic.token') || '';
}

export function setToken(token: string): void {
  localStorage.setItem('sonic.token', token);
}

export function isElectron(): boolean {
  return Boolean((window as { sonicDesktop?: unknown }).sonicDesktop);
}

export function mediaUrl(p: string): string {
  const token = getToken();
  const sep = p.includes('?') ? '&' : '?';
  return API_BASE + p + (token ? `${sep}token=${encodeURIComponent(token)}` : '');
}

export function wsUrl(): string {
  const base = API_BASE || (location.protocol === 'https:' ? 'wss://' + location.host : 'ws://' + location.host);
  const wsBase = base.replace(/^http/, 'ws');
  const token = getToken();
  return wsBase + '/ws' + (token ? `?token=${encodeURIComponent(token)}` : '');
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public data?: unknown) {
    super(message);
  }
}

type ToastFn = (level: 'info' | 'success' | 'error', message: string) => void;
let toastHandler: ToastFn = () => {};
export function setToastHandler(fn: ToastFn): void { toastHandler = fn; }
let authHandler: (() => void) | null = null;
export function setAuthHandler(fn: () => void): void { authHandler = fn; }

async function request<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['x-auth-token'] = token;
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
    toastHandler('error', 'Нет соединения с сервером Sonic Studio');
    throw new ApiError(0, 'Нет соединения с сервером');
  }
  if (res.status === 401 && authHandler) {
    authHandler();
    throw new ApiError(401, 'Требуется авторизация', 'AUTH_REQUIRED');
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err = (data as { error?: string; code?: string }) || {};
    throw new ApiError(res.status, err.error || `Ошибка сервера (${res.status})`, err.code, data);
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

export async function login(pin: string): Promise<void> {
  const r = await request<{ ok: true; token: string }>('POST', '/api/auth/login', { pin });
  setToken(r.token);
}
