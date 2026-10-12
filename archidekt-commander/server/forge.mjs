// Forge (open-source MTG rules engine) integration: install Java + Forge into data/forge, index Forge's card
// names, write .dck files and run headless AI-vs-AI games ("sim" mode). Windows first, works on Linux/macOS.
//
// Layout under data/forge/:
//   java/          Java runtime (Temurin JRE 21), unless FORGE_JAVA or a system Java 17+ is used
//   app/           Forge release (forge-gui-desktop-<v>-jar-with-dependencies.jar + res/)
//   names.json     lower-case normalized card name → Forge card name
//   install.json   {forgeVersion, java, jar, installedAt}

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { log } from './client.mjs';
import { dataDir, ensureDir, envValue, homeDir, normName, readJson, ToolError, writeJson } from './store.mjs';
import { unzipFile, zipEntries, zipRead } from './zip.mjs';

export const FORGE_PINNED = { version: '2.0.15', url: 'https://github.com/Card-Forge/forge/releases/download/forge-2.0.15/forge-installer-2.0.15.tar.bz2' };
const JAVA_PINNED = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.8%2B9/';
const JAVA_FILES = {
  'win32-x64': 'OpenJDK21U-jre_x64_windows_hotspot_21.0.8_9.zip',
  'linux-x64': 'OpenJDK21U-jre_x64_linux_hotspot_21.0.8_9.tar.gz',
  'linux-arm64': 'OpenJDK21U-jre_aarch64_linux_hotspot_21.0.8_9.tar.gz',
  'darwin-arm64': 'OpenJDK21U-jre_aarch64_mac_hotspot_21.0.8_9.tar.gz',
  'darwin-x64': 'OpenJDK21U-jre_x64_mac_hotspot_21.0.8_9.tar.gz',
};
const ADOPTIUM_OS = { win32: 'windows', linux: 'linux', darwin: 'mac' };
const ADOPTIUM_ARCH = { x64: 'x64', arm64: 'aarch64' };

export const forgeDir = (...p) => dataDir('forge', ...p);
const installFile = () => forgeDir('install.json');
const namesFile = () => forgeDir('names.json');
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

// ---------------- detection ----------------

function javaMajor(javaBin) {
  try {
    const r = spawnSync(javaBin, ['-version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    const out = `${r.stderr || ''}${r.stdout || ''}`;
    const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
    if (!m) return null;
    const major = Number(m[1]) === 1 ? Number(m[2]) : Number(m[1]);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

function findJavaIn(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  for (let depth = 0; depth < 4 && stack.length; depth++) {
    const next = [];
    for (const d of stack) {
      const cand = path.join(d, 'bin', exe('java'));
      if (fs.existsSync(cand)) return cand;
      const mac = path.join(d, 'Contents', 'Home', 'bin', 'java');
      if (fs.existsSync(mac)) return mac;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) next.push(path.join(d, e.name));
    }
    stack.splice(0, stack.length, ...next);
  }
  return null;
}

function findJar(dir) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => /^forge-gui-desktop-.*-jar-with-dependencies\.jar$/.test(n));
  return f ? path.join(dir, f) : null;
}

/** Current installation state (never throws). */
export function forgeStatus() {
  const javaEnv = envValue('FORGE_JAVA');
  const jarEnv = envValue('FORGE_JAR');
  const java = javaEnv || findJavaIn(forgeDir('java')) || null;
  const jar = jarEnv || findJar(forgeDir('app'));
  const names = fs.existsSync(namesFile());
  const info = readJson(installFile(), {}) || {};
  let systemJava = null;
  if (!java) {
    const major = javaMajor('java');
    if (major && major >= 17) systemJava = 'java';
  }
  const javaBin = java || systemJava;
  return {
    ready: !!(javaBin && jar && names),
    java: javaBin,
    jar,
    appDir: jar ? path.dirname(jar) : null,
    namesIndexed: names,
    forgeVersion: info.forgeVersion || (jar ? /desktop-(.+?)-jar/.exec(path.basename(jar))?.[1] : null),
    installedAt: info.installedAt || null,
    cpus: os.cpus().length,
    totalMemGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
  };
}

// ---------------- download / extract helpers ----------------

async function download(url, file, { label, onProgress } = {}) {
  ensureDir(path.dirname(file));
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'archidekt-commander-mcp' } });
  if (!res.ok || !res.body) throw new ToolError('network', `Download falhou (${res.status}) em ${label || url}`);
  const total = Number(res.headers.get('content-length')) || null;
  let got = 0;
  const tmp = `${file}.part`;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    got += c.length;
    onProgress?.(got, total);
  });
  await pipeline(src, fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  return file;
}

function tarBin() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

function untar(file, dest) {
  ensureDir(dest);
  const flags = file.endsWith('.bz2') ? '-xjf' : file.endsWith('.gz') || file.endsWith('.tgz') ? '-xzf' : '-xf';
  return new Promise((resolve, reject) => {
    const p = spawn(tarBin(), [flags, file, '-C', dest], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new ToolError('setup', `tar indisponível: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new ToolError('setup', `tar falhou (${code}): ${err.slice(0, 300)}`))));
  });
}

async function latestForgeAsset() {
  try {
    const r = await fetch('https://api.github.com/repos/Card-Forge/forge/releases/latest', {
      headers: { 'User-Agent': 'archidekt-commander-mcp', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return FORGE_PINNED;
    const j = await r.json();
    const a = (j.assets || []).find((x) => /^forge-installer-.*\.tar\.bz2$/.test(x.name));
    if (!a) return FORGE_PINNED;
    return { version: /installer-(.+)\.tar\.bz2$/.exec(a.name)?.[1] || j.tag_name, url: a.browser_download_url };
  } catch {
    return FORGE_PINNED;
  }
}

/** A Forge archive the user (or a previous run) left in <home>/forge/ is used instead of downloading. */
function localForgeArchive() {
  const dirs = [path.join(homeDir(), 'forge'), forgeDir()];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const f = fs.readdirSync(d).filter((n) => /^forge-installer-.*\.tar\.bz2$/.test(n)).sort().pop();
    if (f) return { version: /installer-(.+)\.tar\.bz2$/.exec(f)[1], file: path.join(d, f) };
  }
  return null;
}

/** Builds names.json from Forge's res/cardsfolder/cardsfolder.zip (or loose .txt files). */
export function indexForgeNames(appDir) {
  const zip = path.join(appDir, 'res', 'cardsfolder', 'cardsfolder.zip');
  const map = {};
  const add = (text) => {
    for (const m of text.matchAll(/^Name:(.*)$/gm)) {
      const n = m[1].trim();
      if (n) map[normName(n)] ??= n;
    }
  };
  if (fs.existsSync(zip)) {
    const buf = fs.readFileSync(zip);
    for (const e of zipEntries(buf)) if (!e.isDir && e.name.endsWith('.txt')) add(zipRead(buf, e).toString('utf8'));
  } else {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.txt')) add(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(path.join(appDir, 'res', 'cardsfolder'));
  }
  writeJson(namesFile(), map);
  return Object.keys(map).length;
}

let namesCache = null;
export function forgeNames() {
  if (namesCache) return namesCache;
  const j = readJson(namesFile(), null);
  if (!j) return null;
  namesCache = new Map(Object.entries(j));
  return namesCache;
}

// ---------------- setup job ----------------

const setupJob = { running: false, step: null, progress: null, error: null, startedAt: null, finishedAt: null, promise: null };

export function setupStatus() {
  return { ...forgeStatus(), job: { running: setupJob.running, step: setupJob.step, progress: setupJob.progress, error: setupJob.error, startedAt: setupJob.startedAt, finishedAt: setupJob.finishedAt } };
}

async function runSetup({ force }) {
  const tmp = ensureDir(forgeDir('downloads'));
  const pct = (got, total) => (setupJob.progress = total ? `${Math.round((got / total) * 100)}% de ${Math.round(total / 2 ** 20)} MB` : `${Math.round(got / 2 ** 20)} MB`);

  // 1) Java
  let st = forgeStatus();
  if (force || !st.java) {
    const key = `${process.platform}-${process.arch}`;
    const fileName = JAVA_FILES[key];
    const osName = ADOPTIUM_OS[process.platform];
    const arch = ADOPTIUM_ARCH[process.arch];
    if (!fileName && !(osName && arch)) throw new ToolError('setup', `Plataforma sem Java automático (${key}). Instale o Java 17+ e defina FORGE_JAVA.`);
    setupJob.step = 'baixando Java (Temurin 21)';
    const archive = path.join(tmp, fileName || `jre-${key}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`);
    if (!fs.existsSync(archive)) {
      try {
        await download(`https://api.adoptium.net/v3/binary/latest/21/ga/${osName}/${arch}/jre/hotspot/normal/eclipse`, archive, { label: 'Java (Adoptium)', onProgress: pct });
      } catch (e) {
        if (!fileName) throw e;
        log(`adoptium API failed (${e.message}); trying pinned GitHub URL`);
        await download(JAVA_PINNED + fileName, archive, { label: 'Java (GitHub)', onProgress: pct });
      }
    }
    setupJob.step = 'extraindo Java';
    fs.rmSync(forgeDir('java'), { recursive: true, force: true });
    ensureDir(forgeDir('java'));
    if (archive.endsWith('.zip')) unzipFile(archive, forgeDir('java'));
    else await untar(archive, forgeDir('java'));
    if (!findJavaIn(forgeDir('java'))) throw new ToolError('setup', 'Java extraído mas o executável não foi encontrado.');
  }

  // 2) Forge
  st = forgeStatus();
  let forgeVersion = st.forgeVersion;
  if (force || !st.jar) {
    let archive;
    const local = localForgeArchive();
    if (local && !force) {
      archive = local.file;
      forgeVersion = local.version;
    } else {
      setupJob.step = 'procurando a versão mais nova do Forge';
      const asset = await latestForgeAsset();
      forgeVersion = asset.version;
      archive = path.join(tmp, `forge-installer-${asset.version}.tar.bz2`);
      if (!fs.existsSync(archive)) {
        setupJob.step = `baixando Forge ${asset.version}`;
        await download(asset.url, archive, { label: 'Forge (GitHub)', onProgress: pct });
      }
    }
    setupJob.step = 'extraindo Forge (pode levar 1–2 min)';
    setupJob.progress = null;
    fs.rmSync(forgeDir('app'), { recursive: true, force: true });
    await untar(archive, forgeDir('app'));
    if (!findJar(forgeDir('app'))) throw new ToolError('setup', 'Forge extraído mas o .jar não foi encontrado.');
  }

  // 3) names index
  setupJob.step = 'indexando nomes de cartas do Forge';
  namesCache = null;
  const n = indexForgeNames(path.dirname(findJar(forgeDir('app')) || envValue('FORGE_JAR')));
  writeJson(installFile(), { forgeVersion, java: forgeStatus().java, jar: forgeStatus().jar, installedAt: new Date().toISOString(), cardNames: n }, { pretty: true });
  return { cardNames: n };
}

/** Starts (or reports) the background installation. */
export function startSetup({ force = false } = {}) {
  if (setupJob.running) return { started: false, status: 'instalação em andamento', ...setupStatus() };
  const st = forgeStatus();
  if (st.ready && !force) return { started: false, status: 'Forge já instalado', ...setupStatus() };
  Object.assign(setupJob, { running: true, step: 'iniciando', progress: null, error: null, startedAt: new Date().toISOString(), finishedAt: null });
  setupJob.promise = runSetup({ force })
    .catch((e) => {
      setupJob.error = String(e?.message || e);
      log(`forge setup failed: ${setupJob.error}`);
    })
    .finally(() => {
      setupJob.running = false;
      setupJob.step = setupJob.error ? 'falhou' : 'pronto';
      setupJob.finishedAt = new Date().toISOString();
    });
  return { started: true, status: 'instalação iniciada em segundo plano', ...setupStatus() };
}

export const waitForSetup = () => setupJob.promise ?? Promise.resolve();

// ---------------- decks ----------------

/** Forge-safe player label (no spaces/dots/parentheses — the log parser relies on it). */
export const forgeLabel = (s) =>
  normName(s).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'deck';

/** Resolves an Archidekt card name to Forge's name (exact, accent-insensitive, then front face). */
export function toForgeName(name, names = forgeNames()) {
  if (!names) return null;
  const full = names.get(normName(name));
  if (full) return full;
  if (name.includes(' // ')) {
    const front = names.get(normName(name.split(' // ')[0]));
    if (front) return front;
  }
  return null;
}

/**
 * Builds a Forge .dck from a parsed Archidekt deck (commander.mjs parseDeck). Returns {text, missing, count}.
 * `swaps` [{out, in}] lets the A/B test play a modified list without touching the deck on Archidekt.
 */
export function buildDck(parsed, label, { names = forgeNames(), swaps = [] } = {}) {
  const rows = parsed.rows.filter((r) => r.included).map((r) => ({ name: r.name, qty: r.qty, cmd: r.isCommander }));
  for (const s of swaps) {
    const i = rows.findIndex((r) => normName(r.name) === normName(s.out) && !r.cmd);
    if (i < 0) throw new ToolError('input', `Troca inválida: "${s.out}" não está no deck.`);
    if (rows[i].qty > 1) rows[i].qty--;
    else rows.splice(i, 1);
    rows.push({ name: s.in, qty: 1, cmd: false });
  }
  const cmd = [];
  const main = [];
  const missing = [];
  let count = 0;
  for (const r of rows) {
    count += r.qty;
    const f = toForgeName(r.name, names);
    if (!f) {
      missing.push(r.name);
      continue;
    }
    (r.cmd ? cmd : main).push(`${r.qty} ${f}`);
  }
  const text = `[metadata]\nName=${label}\n[Commander]\n${cmd.join('\n')}\n[Main]\n${main.join('\n')}\n`;
  return { text, missing, count };
}

// ---------------- running games ----------------

/**
 * Runs `games` games of Commander between the given .dck files (seat order = array order) and writes the full
 * Forge log to `logFile`. Resolves {code, ms, killed}. `child` is exposed to allow stopping.
 */
export function runSim({ deckDir, deckFiles, games = 1, seed = null, clockSec = 300, logFile, xmxMb = 1536, timeoutMs = null }) {
  const st = forgeStatus();
  if (!st.java || !st.jar) throw new ToolError('setup', 'Forge não está instalado. Rode forge_setup primeiro.');
  const args = [
    `-Xmx${xmxMb}m`,
    '-Djava.awt.headless=true',
    '-Dfile.encoding=UTF-8',
    '-Dio.netty.tryReflectionSetAccessible=true',
    '-jar',
    st.jar,
    'sim',
    '-D',
    path.resolve(deckDir),
    '-d',
    ...deckFiles,
    '-f',
    'commander',
    '-n',
    String(games),
    '-c',
    String(clockSec),
  ];
  if (seed != null) args.push('-s', String(seed));
  ensureDir(path.dirname(logFile));
  const out = fs.openSync(logFile, 'w');
  const t0 = Date.now();
  const child = spawn(st.java, args, { cwd: st.appDir, windowsHide: true, stdio: ['ignore', out, out] });
  let killed = false;
  // Safety net: if every game already reported its result but the JVM lingers, stop it after 20 s.
  let doneSince = null;
  const watch = setInterval(() => {
    try {
      const txt = fs.readFileSync(logFile, 'utf8');
      const n = (txt.match(/^Game Result:/gm) || []).length;
      if (n >= games) {
        doneSince ??= Date.now();
        if (Date.now() - doneSince > 20_000) child.kill();
      }
    } catch {
      /* log not there yet */
    }
  }, 5000);
  watch.unref?.();
  const timer = timeoutMs
    ? setTimeout(() => {
        killed = true;
        child.kill();
      }, timeoutMs)
    : null;
  const promise = new Promise((resolve) => {
    child.on('error', (e) => {
      clearInterval(watch);
      fs.closeSync(out);
      resolve({ code: -1, ms: Date.now() - t0, killed, error: e.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      clearInterval(watch);
      try {
        fs.closeSync(out);
      } catch {
        /* closed */
      }
      resolve({ code, ms: Date.now() - t0, killed });
    });
  });
  return {
    child,
    promise,
    stop: () => {
      killed = true;
      child.kill();
    },
  };
}

/** How many Forge processes to run at once on this machine (each one is a JVM with ~1.5 GB heap). */
export function defaultWorkers() {
  const env = envValue('FORGE_WORKERS');
  if (env && Number(env) > 0) return Math.min(16, Math.floor(Number(env)));
  const cpu = Math.max(1, Math.floor(os.cpus().length / 3));
  const mem = Math.max(1, Math.floor((os.totalmem() / 2 ** 30 - 4) / 1.8));
  return Math.max(1, Math.min(6, cpu, mem));
}
