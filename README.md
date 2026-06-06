# omo-watcher

Image hook plugin for [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent).

Automatically saves pasted images to disk and instructs Sisyphus to use `look_at` for visual analysis.

## Features

- **O(1) deduplication**: Hash-based cache prevents duplicate saves
- **Lazy initialization**: Minimal overhead until first image paste
- **Timer-based cleanup**: Non-blocking background cleanup every 10 minutes
- **Built-in instructions**: No manual prompt configuration needed
- **Handles edge cases**: Non-data-url images preserved, concurrent saves safe

## Install

### 1. Clone & build

```bash
git clone https://github.com/Jiajun0413/omo-watcher.git
cd omo-watcher
bun install
bun run build
```

### 2. Add to opencode config

In `~/.config/opencode/oh-my-openagent.jsonc`:

```jsonc
{
  "plugin": [
    "oh-my-opencode-slim",
    "/absolute/path/to/omo-watcher"
  ]
}
```

**That's it.** The plugin handles everything automatically.

> Use **absolute paths** only. Relative paths may not resolve correctly.

### 3. Restart opencode

```bash
opencode
```

## Uninstall

Remove the omo-watcher path from the `plugin` array.

Clean up saved images:

```bash
rm -rf .opencode/images/
```

## Config Options (Optional)

Pass options as a tuple in the `plugin` array:

```jsonc
{
  "plugin": [
    "oh-my-opencode-slim",
    ["/path/to/omo-watcher", { "maxAgeMs": 7200000, "cleanupIntervalMs": 300000 }]
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `maxAgeMs` | 3600000 (1h) | Max age before cleanup |
| `cleanupIntervalMs` | 600000 (10min) | Cleanup interval |

## How It Works

```
User pastes image → plugin saves to .opencode/images/<name>-<hash>.png
                  → strips binary from message
                  → inserts instruction text
                  → Sisyphus calls look_at(file_path, goal)
                  → multimodal-looker reads & analyzes image
```

**Key optimizations vs omos original:**
- Hash-based O(1) dedup (no counter retry)
- Lazy init (mkdir once per workspace)
- Timer-based cleanup (non-blocking)
- Pre-compiled regex (no repeated compilation)
- Flat directory structure (no session subdirs)

## License

MIT