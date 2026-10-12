// Minimal ZIP reader (stored + deflate, no ZIP64, no encryption) using only node:zlib.
// Used to read Forge's res/cardsfolder/cardsfolder.zip and to unpack the Windows Java runtime (.zip).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  throw new Error('arquivo zip inválido (fim do diretório central não encontrado)');
}

/** Lists entries: [{name, method, compSize, size, offset, isDir}]. */
export function zipEntries(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 não suportado');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('diretório central do zip corrompido');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, size, offset, isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Returns the uncompressed bytes of one entry. */
export function zipRead(buf, e) {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`cabeçalho local inválido: ${e.name}`);
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`método de compressão ${e.method} não suportado (${e.name})`);
}

/** Extracts a zip file into `dest` (refuses paths escaping it). Returns the number of files written. */
export function unzipFile(file, dest) {
  const buf = fs.readFileSync(file);
  const root = path.resolve(dest);
  let n = 0;
  for (const e of zipEntries(buf)) {
    const target = path.resolve(root, e.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`caminho inseguro no zip: ${e.name}`);
    if (e.isDir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zipRead(buf, e));
    n++;
  }
  return n;
}
