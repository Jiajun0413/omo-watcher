import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Plugin, Hooks, PluginInput } from '@opencode-ai/plugin';
import type { Message, Part } from '@opencode-ai/sdk';

// ── Config ──

interface WatcherConfig {
  /** Max file age in ms before cleanup (default: 3600000 = 1h) */
  maxAgeMs?: number;
  /** Cleanup interval in ms (default: 600000 = 10min) */
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

// ── Helpers ──

const IMG_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?|heic)$/i;

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
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], data: Buffer.from(m[2], 'base64') };
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp',
  'image/tiff': '.tiff', 'image/heic': '.heic',
};

function mimeToExt(mime: string): string {
  return MIME_EXT[mime] ?? '.png';
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ── Cleanup ──

let lastCleanup = 0;

function cleanup(dir: string, maxAge: number, interval: number): void {
  const now = Date.now();
  if (now - lastCleanup < interval) return;
  lastCleanup = now;
  try {
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f);
      try { if (now - statSync(fp).mtimeMs > maxAge) unlinkSync(fp); } catch {}
    }
  } catch {}
}

// ── Save ──

function save(dir: string, name: string, data: Buffer): string | null {
  const fp = join(dir, name);
  try {
    writeFileSync(fp, data, { flag: 'wx' });
    return fp;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return fp;
    return null;
  }
}

// ── Nudge ──

function nudge(paths: string[]): string {
  const first = paths[0] ?? '/path/to/image.png';
  return `[Image saved: ${paths.join(', ')}. Use look_at(file_path="${first}", goal="describe & extract text") to analyze — it calls multimodal-looker internally. Do NOT use Read on images.]`;
}

// ── Hook ──

function processImages(msgs: MsgWithParts[], workDir: string, cfg: Required<WatcherConfig>): void {
  const saveDir = join(workDir, '.opencode', 'images');
  let hasImages = false;

  for (const msg of msgs) {
    if (msg.info.role !== 'user') continue;
    const imgParts = (msg.parts as FilePart[]).filter(isImage);
    if (imgParts.length === 0) continue;

    hasImages = true;
    mkdirSync(saveDir, { recursive: true });

    const giPath = join(workDir, '.opencode', '.gitignore');
    if (!existsSync(giPath)) writeFileSync(giPath, '*\n');

    const saved: string[] = [];
    for (const p of imgParts) {
      const url = p.url as string | undefined;
      if (!url) continue;
      const dec = decodeDataUrl(url);
      if (!dec) continue;

      const hash = createHash('sha1').update(dec.data).digest('hex').slice(0, 8);
      const rawName = (p.filename ?? p.name) as string | undefined;
      const base = rawName ? sanitize(rawName).replace(/\.[^.]+$/, '') || 'image' : 'image';
      const ext = rawName ? extname(sanitize(rawName)) || mimeToExt(dec.mime) : mimeToExt(dec.mime);
      const fileName = `${base}-${hash}${ext}`;

      const fp = save(saveDir, fileName, dec.data);
      if (fp) saved.push(fp);
    }

    msg.parts = msg.parts
      .filter((p) => !isImage(p as FilePart))
      .concat([{ type: 'text', text: nudge(saved) }] as Part[])
  }

  if (!hasImages && existsSync(saveDir)) cleanup(saveDir, cfg.maxAgeMs, cfg.cleanupIntervalMs);
  if (hasImages) cleanup(saveDir, cfg.maxAgeMs, cfg.cleanupIntervalMs);
}

// ── Export ──

export default (async (ctx: PluginInput, options?: WatcherConfig): Promise<Hooks> => {
  const cfg: Required<WatcherConfig> = { ...DEFAULTS, ...options };
  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      processImages(output.messages, ctx.directory, cfg);
    },
  };
}) satisfies Plugin;