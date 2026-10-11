// Local storage: data/wiki locations, atomic writes, JSON helpers, text normalization, throttling.
// Everything here works on Windows and POSIX (path.join, os.homedir, no shell).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.6.0';
export const USER_AGENT = `archidekt-commander-mcp/0.6`;

/**
 * Reads an environment variable, treating empty values and unreplaced placeholders
 * (e.g. "${user_config.data_dir}" left by an MCPB host when an optional field is blank) as unset.
 */
export function envValue(name) {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = String(v).trim();
  if (!t || /^\$\{[^}]*\}$/.test(t)) return undefined;
  return t;
}

/** Root folder: ARCHIDEKT_HOME, else ~/Projects/archidekt-mcp if it exists, else ~/.archidekt. */
export function homeDir() {
  const custom = envValue('ARCHIDEKT_HOME');
  if (custom) return path.resolve(custom);
  const projects = path.join(os.homedir(), 'Projects', 'archidekt-mcp');
  try {
    if (fs.statSync(projects).isDirectory()) return projects;
  } catch {
    /* not there */
  }
  return path.join(os.homedir(), '.archidekt');
}

export const dataDir = (...p) => path.join(homeDir(), 'data', ...p);
export const wikiDir = (...p) => path.join(homeDir(), 'wiki', ...p);

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Write a file atomically: write a temp file next to it, then rename over the target. */
export function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, data);
  // Windows can briefly refuse the rename when an antivirus/indexer holds the target open.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i < 5 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        sleepSync(50 * (i + 1));
        continue;
      }
      if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        // Windows: target still held open (antivirus/indexer/editor) — overwrite in place as a last resort.
        try {
          fs.copyFileSync(tmp, file);
          fs.unlinkSync(tmp);
          return;
        } catch {
          /* fall through: report the original error */
        }
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj, { pretty = false } = {}) {
  writeFileAtomic(file, pretty ? JSON.stringify(obj, null, 1) : JSON.stringify(obj));
}

export function envInt(name, dflt) {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) && v >= 0 ? v : dflt;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serial queue that keeps calls at least `interval()` ms apart. */
export class Throttle {
  constructor(intervalFn) {
    this.intervalFn = intervalFn;
    this.queue = Promise.resolve();
    this.last = 0;
  }
  run(fn) {
    const job = this.queue.then(async () => {
      const wait = this.last + this.intervalFn() - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
}

/** Card-name normalization: lowercase, strip accents/punctuation, collapse spaces. */
export function normName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/æ/g, 'ae') // "Æther…" (NFD does not decompose ligatures)
    .replace(/œ/g, 'oe')
    .replace(/[’'`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Slug for files/URLs: normalized words joined by '-'. */
export const slugify = (s) => normName(s).replace(/\s+/g, '-');

export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Error with a kind, rendered as a plain "Erro: ..." by the MCP layer (no stack in logs). */
export class ToolError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** fetch with timeout; returns Response or throws ToolError('network'|'timeout'). */
export async function fetchWithTimeout(url, { headers = {}, timeoutMs = 30_000, label = 'request' } = {}) {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ToolError('timeout', `Tempo esgotado em ${label}.`);
    throw new ToolError('network', `Falha de rede em ${label}: ${e.message}`);
  }
}

export const todayIso = () => new Date().toISOString();
export const fileStamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');
