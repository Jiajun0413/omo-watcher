import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { UserMessage, FilePart, TextPart, Part } from '@opencode-ai/sdk';
import type { PluginInput } from '@opencode-ai/plugin';
import createPlugin from './index';

// Minimal 1x1 PNG base64
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// Different 1x1 PNG base64
const PNG_1x1_ALT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function makeMsg(role: 'user' | 'assistant', parts: Part[]): { info: UserMessage; parts: Part[] } {
  return {
    info: {
      id: `msg-${Math.random().toString(36).slice(2)}`,
      sessionID: 'ses-1',
      role,
      time: { created: Date.now() },
      agent: 'sisyphus',
      model: { providerID: 'test', modelID: 'test' },
    },
    parts,
  };
}

function imgPart(url: string, filename?: string): Part {
  return {
    id: `part-${Math.random().toString(36).slice(2)}`,
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'file',
    mime: 'image/png',
    filename,
    url,
  } as Part;
}

function txtPart(text: string): Part {
  return {
    id: `part-${Math.random().toString(36).slice(2)}`,
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'text',
    text,
  } as Part;
}

describe('omo-watcher plugin', () => {
  let tmpDir: string;
  let plugin: Awaited<ReturnType<typeof createPlugin>>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omo-watcher-'));
    const mockInput: PluginInput = {
      client: {} as any,
      project: {} as any,
      directory: tmpDir,
      worktree: tmpDir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost'),
      $: {} as any,
    };
    plugin = await createPlugin(mockInput, { maxAgeMs: 1000, cleanupIntervalMs: 100 });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── S1: Happy path — single image ──

  test('S1: single image → saved, nudge inserted, non-image parts preserved', async () => {
    const output = {
      messages: [makeMsg('user', [imgPart(`data:image/png;base64,${PNG_1x1}`, 'shot.png'), txtPart('hello')])],
    };

    await plugin['experimental.chat.messages.transform']!({}, output);
    const parts = output.messages[0].parts;

    // Should have text part and nudge
    expect(parts.length).toBe(2);
    const textParts = parts.filter((p) => p.type === 'text');
    expect(textParts.length).toBe(2);

    // Nudge references saved file
    const nudge = textParts.find((p) => (p as TextPart).text.startsWith('[Image:'));
    expect(nudge).toBeDefined();
    const nudgePath = (nudge as TextPart).text.match(/^\[Image: (.+)\]$/)?.[1];
    expect(nudgePath).toBeDefined();
    expect(existsSync(nudgePath!)).toBe(true);

    // Original text preserved
    expect(textParts.some((p) => (p as TextPart).text === 'hello')).toBe(true);
  });

  // ── S2: Dedup — same image content → same path ──

  test('S2: same image content twice → same path, only one file on disk', async () => {
    const url = `data:image/png;base64,${PNG_1x1}`;

    const output1 = { messages: [makeMsg('user', [imgPart(url, 'a.png')])] };
    const output2 = { messages: [makeMsg('user', [imgPart(url, 'b.png')])] };

    await plugin['experimental.chat.messages.transform']!({}, output1);
    await plugin['experimental.chat.messages.transform']!({}, output2);

    // Both should reference the same path
    const nudge1 = (output1.messages[0].parts[0] as TextPart).text;
    const nudge2 = (output2.messages[0].parts[0] as TextPart).text;
    const path1 = nudge1.match(/^\[Image: (.+)\]$/)?.[1];
    const path2 = nudge2.match(/^\[Image: (.+)\]$/)?.[1];
    expect(path1).toBe(path2);

    // Only one file in images dir
    const files = readdirSync(join(tmpDir, '.opencode', 'images'));
    expect(files.length).toBe(1);
  });

  // ── S3: Edge — empty message (no images) ──

  test('S3: message with no images → untouched', async () => {
    const output = {
      messages: [makeMsg('user', [txtPart('hello'), txtPart('world')])],
    };

    await plugin['experimental.chat.messages.transform']!({}, output);
    const parts = output.messages[0].parts;

    expect(parts.length).toBe(2);
    expect((parts[0] as TextPart).text).toBe('hello');
    expect((parts[1] as TextPart).text).toBe('world');
  });

  // ── S4: Edge — multiple images in one message ──

  test('S4: multiple images → all saved, one nudge with first path', async () => {
    const output = {
      messages: [makeMsg('user', [
        imgPart(`data:image/png;base64,${PNG_1x1}`, 'a.png'),
        imgPart(`data:image/png;base64,${PNG_1x1_ALT}`, 'b.png'),
      ])],
    };

    await plugin['experimental.chat.messages.transform']!({}, output);
    const parts = output.messages[0].parts;

    // Only nudge text (no image parts)
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('text');

    // Both files saved
    const files = readdirSync(join(tmpDir, '.opencode', 'images'));
    expect(files.length).toBe(2);
  });

  // ── S5: Edge — different image content → different files ──

  test('S5: different images → different files saved', async () => {
    const output = {
      messages: [makeMsg('user', [imgPart(`data:image/png;base64,${PNG_1x1}`)])],
    };

    await plugin['experimental.chat.messages.transform']!({}, output);
    const files1 = readdirSync(join(tmpDir, '.opencode', 'images'));
    expect(files1.length).toBe(1);

    const output2 = {
      messages: [makeMsg('user', [imgPart(`data:image/png;base64,${PNG_1x1_ALT}`)])],
    };
    await plugin['experimental.chat.messages.transform']!({}, output2);
    const files2 = readdirSync(join(tmpDir, '.opencode', 'images'));
    expect(files2.length).toBe(2);
  });

  // ── S6: Adjacent — assistant messages skipped ──

  test('S6: assistant message with images → untouched', async () => {
    const output = {
      messages: [makeMsg('assistant', [imgPart(`data:image/png;base64,${PNG_1x1}`)])],
    };

    await plugin['experimental.chat.messages.transform']!({}, output);
    const parts = output.messages[0].parts;

    // Image parts preserved (not stripped)
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('file');
  });

  // ── S7: Edge — .gitignore created ──

  test('S7: .gitignore is created in .opencode dir', async () => {
    const output = {
      messages: [makeMsg('user', [imgPart(`data:image/png;base64,${PNG_1x1}`)])],
    };

    await plugin['experimental.chat.messages.transform']!({}, output);

    const giPath = join(tmpDir, '.opencode', '.gitignore');
    expect(existsSync(giPath)).toBe(true);
  });

  // ── S8: Edge — no data URL → silently skipped ──

  test('S8: image part without data URL → skipped', async () => {
    const output = {
      messages: [makeMsg('user', [imgPart('https://example.com/img.png')])],
    };

    await plugin['experimental.chat.messages.transform']!({}, output);
    const parts = output.messages[0].parts;

    // Image part preserved (not a data URL)
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('file');
  });
});