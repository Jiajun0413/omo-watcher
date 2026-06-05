# omo-watcher

Image hook plugin for [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent).

When a user pastes an image into chat, omo-watcher:
1. Saves the image to `.opencode/images/` on disk
2. Strips the binary data from the message
3. Inserts a concise nudge directing Sisyphus to use `look_at` for visual analysis

`look_at` invokes `multimodal-looker` internally — no agent delegation needed.

## Install

### 1. Clone & build

```bash
git clone https://github.com/Jiajun0413/omo-watcher.git
cd omo-watcher
bun install
bun run build
```

### 2. Add to opencode config

In `~/.config/opencode/oh-my-openagent.jsonc` (or your project-level config):

```jsonc
{
  "plugin": [
    "oh-my-opencode-slim",
    "/absolute/path/to/omo-watcher"
  ],

  "agents": {
    "sisyphus": {
      "prompt_append": "Pasted images save to .opencode/images/. Use look_at(file_path=<path>, goal=<intent>) to analyze — calls multimodal-looker. Never Read binary images."
    },
    "multimodal-looker": {
      "prompt_append": "When given file_path via look_at, read the image from disk and analyze per goal."
    }
  }
}
```

> **Note**: Use the **absolute path** to omo-watcher. Relative paths may not resolve correctly.

### 3. Restart opencode

```bash
opencode
```

## Uninstall

Remove the omo-watcher path from the `plugin` array and the `prompt_append` lines from both `sisyphus` and `multimodal-looker` agents in your config.

Clean up saved images:

```bash
rm -rf .opencode/images/
```

## Config Options

Pass options as a tuple in the `plugin` array:

```jsonc
{
  "plugin": [
    "oh-my-opencode-slim",
    ["omo-watcher", { "maxAgeMs": 3600000, "cleanupIntervalMs": 600000 }]
  ]
}
```

But if using a local path, options are not supported — edit `DEFAULTS` in `src/index.ts` instead.

| Option | Default | Description |
|---|---|---|
| `maxAgeMs` | 3600000 (1h) | Max age before stale image cleanup |
| `cleanupIntervalMs` | 600000 (10min) | How often to scan for stale files |

## How It Works

```
User pastes image → plugin saves to .opencode/images/
                  → strips binary from message
                  → inserts nudge text
                  → Sisyphus calls look_at(file_path, goal)
                  → multimodal-looker reads & analyzes image
```

No observer delegation. No fallback paths. Just `look_at` → `multimodal-looker`.

## License

MIT