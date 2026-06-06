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

/** O(1) hash existence check. Uses Set for thread-safety. */
const savedHashes = new Map<string, Set<string>>(); // dir → Set<hash>
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

// ── Hash Set (O(1) existence check, thread-safe with Set) ──

function ensureHashSet(dir: string): void {
  if (savedHashes.has(dir)) return;
  const hashes = new Set<string>();
  try {
    for (const f of readdirSync(dir)) {
      const m = f.match(HASH_RE);
      if (m) hashes.add(m[1]);
    }
  } catch {}
  savedHashes.set(dir, hashes);
}

// ── Save (O(1) dedup via hash Set, no race condition) ──

function save(dir: string, hash: string, name: string, data: Buffer): string | null {
  ensureHashSet(dir);
  const hashes = savedHashes.get(dir)!;

  // O(1) Set check — if hash exists, assume file exists (no fs lookup)
  if (hashes.has(hash)) {
    // Find existing file with this hash
    try {
      for (const f of readdirSync(dir)) {
        const m = f.match(HASH_RE);
        if (m && m[1] === hash) return join(dir, f);
      }
    } catch {}
  }

  const fp = join(dir, name);
  try {
    writeFileSync(fp, data, { flag: 'wx' });
    hashes.add(hash);
    return fp;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      hashes.add(hash);
      return fp;
    }
    return null;
  }
}

// ── Cleanup ──

function cleanup(dir: string, maxAge: number): void {
  const now = Date.now();
  const hashes = savedHashes.get(dir);
  try {
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f);
      try {
        if (now - statSync(fp).mtimeMs > maxAge) {
          unlinkSync(fp);
          // Evict from Set
          const m = f.match(HASH_RE);
          if (m && hashes) hashes.delete(m[1]);
        }
      } catch {}
    }
  } catch {}
}

// ── Nudge (complete instruction for Sisyphus) ──

function nudge(paths: string[]): string {
  const first = paths[0] ?? '/path/to/image.png';
  return `[Image saved: ${first}. Use look_at(file_path="${first}", goal="describe and extract text") to analyze. The look_at tool calls multimodal-looker internally. Do NOT use Read on binary images.]`;
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
    const failedParts: Part[] = []; // Non-data-url images
    for (const p of imgParts) {
      const url = p.url as string | undefined;
      if (!url) continue;
      const dec = decodeDataUrl(url);
      if (!dec) {
        // Non-data-url image — keep it in message
        failedParts.push(p as Part);
        continue;
      }

      const hash = createHash('sha1').update(dec.data).digest('hex').slice(0, 8);
      const rawName = (p.filename ?? p.name) as string | undefined;
      const sanitized = rawName ? sanitize(rawName) : '';
      const base = sanitized ? sanitized.replace(/\.[^.]+$/, '') || 'image' : 'image';
      const ext = sanitized ? extname(sanitized) || mimeToExt(dec.mime) : mimeToExt(dec.mime);
      const fileName = `${base}-${hash}${ext}`;

      const fp = save(saveDir, hash, fileName, dec.data);
      if (fp) saved.push(fp);
    }

    // Reconstruct parts: non-image + failed-to-decode + nudge (if any saved)
    const newParts = [...otherParts, ...failedParts];
    if (saved.length > 0) {
      newParts.push({ type: 'text', text: nudge(saved) } as Part);
    }
    msg.parts = newParts;
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
    dispose: async () => {
      clearInterval(timer);
    },
  };
}) satisfies Plugin;