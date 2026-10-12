// Archidekt HTTP client: credentials, JWT auth, rate limiting, retries.
// Unofficial API — see README. Never logs or returns credentials/tokens.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envValue } from './store.mjs';

export const USER_AGENT = 'archidekt-commander-mcp/0.8';
const DEFAULT_BASE = 'https://archidekt.com/api';
const TIMEOUT_MS = 20_000;
const MAX_429_RETRIES = 2;
const MAX_RETRY_AFTER_S = 60;

export function log(...args) {
  process.stderr.write(`[archidekt] ${args.join(' ')}\n`);
}

export class ArchidektError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // 'http' | 'auth' | 'not_configured' | 'network' | 'timeout' | 'not_found' | 'input' | 'contract'
    this.status = status;
  }
}

// ---------- credentials ----------

function credentialCandidates() {
  const home = os.homedir();
  const list = [];
  const custom = envValue('ARCHIDEKT_CREDENTIALS_FILE');
  if (custom) list.push(custom);
  list.push(path.join(home, '.archidekt', 'credentials.json'));
  list.push(path.join(home, 'Projects', 'archidekt-mcp', 'credentials.json'));
  return list;
}

/** Returns {login, password, source} or null. `source` is a description safe to show. */
export function loadCredentials() {
  const envLogin = envValue('ARCHIDEKT_EMAIL') || envValue('ARCHIDEKT_USERNAME');
  const envPassword = process.env.ARCHIDEKT_PASSWORD;
  if (envLogin && envPassword && envValue('ARCHIDEKT_PASSWORD')) {
    return { login: envLogin, password: envPassword, source: 'environment variables' };
  }
  for (const file of credentialCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); // strip BOM (Notepad)
      const data = JSON.parse(raw);
      const login = data.email || data.username;
      if (login && data.password) return { login: String(login), password: String(data.password), source: file };
      log(`credentials file ${file} is missing "email"/"username" or "password"`);
    } catch (e) {
      log(`could not read credentials file ${file}: ${e instanceof SyntaxError ? "invalid JSON" : e.code || "read error"}`); // never echo file content
    }
  }
  return null;
}

export const NOT_CONFIGURED_MESSAGE =
  'Credenciais do Archidekt não configuradas. Na extensão (.mcpb), abra as configurações da extensão ' +
  '"Archidekt Commander" no Claude e preencha e-mail e senha. No plugin, crie o arquivo ' +
  '%USERPROFILE%\\.archidekt\\credentials.json (ou %USERPROFILE%\\Projects\\archidekt-mcp\\credentials.json) ' +
  'com {"email": "...", "password": "..."}, ou defina as variáveis de ambiente ARCHIDEKT_EMAIL e ' +
  'ARCHIDEKT_PASSWORD (ou ARCHIDEKT_CREDENTIALS_FILE apontando para o JSON), e reinicie o Claude. ' +
  'Nunca cole a senha no chat. Ferramentas públicas (buscar decks/cartas, ver deck público) funcionam sem login.';

function jwtExp(token) {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function pick(obj, keys) {
  for (const k of keys) if (obj && typeof obj[k] === 'string' && obj[k]) return obj[k];
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- client ----------

export class ArchidektClient {
  constructor({ base, minIntervalMs, credentials } = {}) {
    this.base = (base || process.env.ARCHIDEKT_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
    const envInterval = Number(process.env.ARCHIDEKT_MIN_INTERVAL_MS);
    this.minIntervalMs = minIntervalMs ?? (Number.isFinite(envInterval) && envInterval >= 0 ? envInterval : 1500);
    this.credentials = credentials === undefined ? loadCredentials() : credentials;
    this.access = null;
    this.accessExp = null;
    this.refresh = null;
    this.user = null; // {id, username}
    this._queue = Promise.resolve();
    this._lastAt = 0;
    this._loginPromise = null;
  }

  get hasCredentials() {
    return !!this.credentials;
  }

  // Serialized queue: one request at a time, >= minIntervalMs apart.
  _enqueue(fn) {
    const run = this._queue.then(async () => {
      const wait = this._lastAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this._lastAt = Date.now();
      }
    });
    this._queue = run.catch(() => {});
    return run;
  }

  _url(p, params) {
    const url = new URL(this.base + (p.startsWith('/') ? p : '/' + p));
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** One raw HTTP exchange through the queue. Returns {status, headers, body}. */
  async _send(method, p, { params, body, token } = {}) {
    return this._enqueue(async () => {
      const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `JWT ${token}`;
      let res;
      try {
        res = await fetch(this._url(p, params), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new ArchidektError('timeout', `Tempo esgotado (${TIMEOUT_MS / 1000}s) em ${method} ${p}`);
        }
        throw new ArchidektError('network', `Falha de rede em ${method} ${p}: ${e.message}`);
      }
      const text = await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: res.status, headers: res.headers, body: parsed };
    });
  }

  // ---------- auth ----------

  async login() {
    if (!this.credentials) throw new ArchidektError('not_configured', NOT_CONFIGURED_MESSAGE);
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = (async () => {
      const { login, password } = this.credentials;
      const body = login.includes('@') ? { email: login, password } : { username: login, password };
      const res = await this._send('POST', '/rest-auth/login/', { body });
      if (res.status !== 200 && res.status !== 201) {
        // Do not echo the response body: it may reflect submitted fields.
        throw new ArchidektError('auth', `Login no Archidekt falhou (HTTP ${res.status}). Verifique email/senha no arquivo de credenciais.`, res.status);
      }
      const b = res.body || {};
      const access = pick(b, ['access_token', 'access', 'token', 'jwt']);
      if (!access) throw new ArchidektError('contract', 'Login respondeu sem token de acesso.');
      this._setAccess(access, b.access_token_expiration);
      this.refresh = pick(b, ['refresh_token', 'refresh']);
      const u = b.user || {};
      this.user = { id: u.id ?? u.pk ?? null, username: u.username ?? null };
      log('logged in');
    })();
    try {
      await this._loginPromise;
    } finally {
      this._loginPromise = null;
    }
  }

  _setAccess(token, expiration) {
    this.access = token;
    this.accessExp = jwtExp(token) ?? (expiration ? Date.parse(expiration) || null : null);
  }

  async _refreshToken() {
    if (!this.refresh) return false;
    const res = await this._send('POST', '/rest-auth/token/refresh/', { body: { refresh: this.refresh } });
    if (res.status !== 200) {
      log(`token refresh failed (HTTP ${res.status}); will re-login`);
      return false;
    }
    const access = pick(res.body || {}, ['access', 'access_token', 'token']);
    if (!access) return false;
    this._setAccess(access, res.body.access_token_expiration);
    log('token refreshed');
    return true;
  }

  /** Make sure we have a usable access token. */
  async ensureAuth({ force = false } = {}) {
    if (!this.credentials) throw new ArchidektError('not_configured', NOT_CONFIGURED_MESSAGE);
    const fresh = this.access && (!this.accessExp || this.accessExp - Date.now() > 60_000);
    if (fresh && !force) return this.access;
    if (this.access && this.refresh) {
      if (await this._refreshToken()) return this.access;
    }
    await this.login();
    return this.access;
  }

  async me() {
    await this.ensureAuth();
    if (this.user?.id == null) throw new ArchidektError('contract', 'Login não retornou o id do usuário.');
    return this.user;
  }

  // ---------- requests ----------

  /**
   * auth: 'none' (anonymous), 'optional' (send token if credentials exist), 'required'.
   * Returns parsed body on 2xx; throws ArchidektError otherwise.
   */
  async request(method, p, { params, body, auth = 'optional' } = {}) {
    const isGet = method === 'GET';
    let useAuth = auth === 'required' || (auth === 'optional' && this.hasCredentials);
    let token = useAuth ? await this.ensureAuth() : null;
    let refreshedOnce = false;
    let retries429 = 0;

    for (;;) {
      const res = await this._send(method, p, { params, body, token });
      if (res.status >= 200 && res.status < 300) return res.body;

      if (res.status === 401 && useAuth && !refreshedOnce) {
        // One retry after refreshing the token — allowed for writes too (request was rejected, not applied).
        refreshedOnce = true;
        this.accessExp = 0;
        token = await this.ensureAuth({ force: true });
        continue;
      }
      if (res.status === 429 && isGet && retries429 < MAX_429_RETRIES) {
        retries429++;
        const ra = Number(res.headers.get('retry-after'));
        const waitS = Number.isFinite(ra) && ra >= 0 ? Math.min(ra, MAX_RETRY_AFTER_S) : 10;
        log(`429 on GET ${p}; waiting ${waitS}s`);
        await sleep(waitS * 1000);
        continue;
      }
      throw httpError(method, p, res);
    }
  }
}

function httpError(method, p, res) {
  let detail = '';
  if (res.body && typeof res.body === 'object') detail = JSON.stringify(res.body).slice(0, 300);
  else if (typeof res.body === 'string') detail = res.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const hints = {
    400: 'requisição rejeitada (ou deck apagado)',
    401: 'não autenticado',
    403: 'sem permissão',
    404: 'não encontrado ou privado',
    429: 'limite de requisições atingido — aguarde um minuto',
  };
  const kind = res.status === 404 ? 'not_found' : 'http';
  const msg = `${method} ${p} → HTTP ${res.status}${hints[res.status] ? ` (${hints[res.status]})` : ''}${detail ? `: ${detail}` : ''}`;
  return new ArchidektError(kind, msg, res.status);
}
