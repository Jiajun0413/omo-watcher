import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Plugin, Hooks, PluginInput } from '@opencode-ai/plugin';
import type { Message, Part } from '@opencode-ai/sdk';

// ── Config ──

interface WatcherConfig {
  maxAgeMs?: number;
  cleanupIntervalMs?: number;
}

const DEFAULTS: Required<WatcherConfig> = {
  maxAgeMs: 60 * 60 * 1000,
  cleanupIntervalMs: 10 * 60 * 1000,
};

// ── Types ──

type MsgWithParts = { info: Message; parts: Part[] };

interface FilePart {
  type: string;
  url?: string;
  mime?: string;
  filename?: string;
  name?: string;
  [key: string]: unknown;
}

// ── Module-Level State ──

/** O(1) hash→filePath lookup. Populated once per directory, then cache-only. */
const hashCache = new Map<string, Map<string, string>>(); // dir → (hash → filePath)
/** Directories that have been initialized (mkdir + .gitignore). */
const initDirs = new Set<string>();

// ── Pre-compiled Constants ──

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;
const IMG_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?|heic)$/i;
const HASH_RE = /-([a-f0-9]{8})\./;

const MIME_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  'image/tiff': '.tiff', 'image/heic': '.heic',
};

// ── Helpers ──

function isImage(p: FilePart): boolean {
  if (p.type === 'image') return true;
  if (p.type === 'file') {
    const m = p.mime as string | undefined;
    if (m?.startsWith('image/')) return true;
    const f = (p.filename ?? p.name) as string | undefined;
    if (f && IMG_EXT.test(f)) return true;
  }
  return false;
}

function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const m = url.match(DATA_URL_RE);
  if (!m) return null;
  return { mime: m[1], data: Buffer.from(m[2], 'base64') };
}

function mimeToExt(mime: string): string {
  return MIME_EXT[mime] ?? '.png';
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ── Lazy Init (O(1) after first call per workDir) ──

function ensureInit(workDir: string, saveDir: string): void {
  if (initDirs.has(workDir)) return;
  mkdirSync(saveDir, { recursive: true });
  const giPath = join(workDir, '.opencode', '.gitignore');
  if (!existsSync(giPath)) writeFileSync(giPath, '*\n');
  initDirs.add(workDir);
}

// ── Hash Cache (one O(n) scan, then O(1) lookups) ──

function ensureHashCache(dir: string): void {
  if (hashCache.has(dir)) return;
  const cache = new Map<string, string>();
  try {
    for (const f of readdirSync(dir)) {
      const m = f.match(HASH_RE);
      if (m) cache.set(m[1], join(dir, f));
    }
  } catch {}
  hashCache.set(dir, cache);
}

// ── Save (O(1) dedup via hash cache) ──

function save(dir: string, hash: string, name: string, data: Buffer): string | null {
  ensureHashCache(dir);
  const cache = hashCache.get(dir)!;

  // O(1) cache lookup
  const cached = cache.get(hash);
  if (cached) return cached;

  const fp = join(dir, name);
  try {
    writeFileSync(fp, data, { flag: 'wx' });
    cache.set(hash, fp);
    return fp;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      cache.set(hash, fp);
      return fp;
    }
    return null;
  }
}

// ── Cleanup ──

function cleanup(dir: string, maxAge: number): void {
  const now = Date.now();
  const cache = hashCache.get(dir);
  try {
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f);
      try {
        if (now - statSync(fp).mtimeMs > maxAge) {
          unlinkSync(fp);
          // Evict from cache
          const m = f.match(HASH_RE);
          if (m && cache) cache.delete(m[1]);
        }
      } catch {}
    }
  } catch {}
}

// ── Nudge ──

function nudge(paths: string[]): string {
  return `[Image: ${paths[0] ?? 'saved'}]`;
}

// ── Hook ──

function processImages(msgs: MsgWithParts[], workDir: string, saveDir: string): void {
  for (const msg of msgs) {
    if (msg.info.role !== 'user') continue;

    // Single-pass partition: separate image and non-image parts
    const imgParts: FilePart[] = [];
    const otherParts: Part[] = [];
    for (const p of msg.parts) {
      if (isImage(p as FilePart)) {
        imgParts.push(p as FilePart);
      } else {
        otherParts.push(p);
      }
    }
    if (imgParts.length === 0) continue;

    ensureInit(workDir, saveDir);

    const saved: string[] = [];
    for (const p of imgParts) {
      const url = p.url as string | undefined;
      if (!url) continue;
      const dec = decodeDataUrl(url);
      if (!dec) continue; // Non-data-url images: leave in otherParts

      const hash = createHash('sha1').update(dec.data).digest('hex').slice(0, 8);
      const rawName = (p.filename ?? p.name) as string | undefined;
      const sanitized = rawName ? sanitize(rawName) : '';
      const base = sanitized ? sanitized.replace(/\.[^.]+$/, '') || 'image' : 'image';
      const ext = sanitized ? extname(sanitized) || mimeToExt(dec.mime) : mimeToExt(dec.mime);
      const fileName = `${base}-${hash}${ext}`;

      const fp = save(saveDir, hash, fileName, dec.data);
      if (fp) saved.push(fp);
    }

    // Only insert nudge if at least one image was saved
    if (saved.length > 0) {
      msg.parts = [...otherParts, { type: 'text', text: nudge(saved) } as Part];
    }
    // If no images were saved (all non-data-url), keep the original parts
  }
}

// ── Export ──

export default (async (ctx: PluginInput, options?: WatcherConfig): Promise<Hooks> => {
  const cfg: Required<WatcherConfig> = { ...DEFAULTS, ...options };
  const saveDir = join(ctx.directory, '.opencode', 'images');

  // Timer-based cleanup (decoupled from message processing)
  const timer = setInterval(() => cleanup(saveDir, cfg.maxAgeMs), cfg.cleanupIntervalMs);
  timer.unref();

  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      processImages(output.messages, ctx.directory, saveDir);
    },
  };
}) satisfies Plugin;