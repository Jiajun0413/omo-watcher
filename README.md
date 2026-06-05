# omo-watcher

Image hook plugin for [oh-my-openagent (omo)](https://github.com/code-yeongyu/oh-my-openagent).

When a user pastes an image into chat, omo-watcher:
1. Saves the image to `.opencode/images/` on disk
2. Strips the binary data from the message
3. Inserts a concise nudge directing Sisyphus to use `look_at` for visual analysis

`look_at` invokes `multimodal-looker` internally — no agent delegation needed.

## Install

Add to your `oh-my-openagent.jsonc` config:

```jsonc
{
  "plugins": {
    "omo-watcher": {
      "source": "github:Jiajun0413/omo-watcher",
      // Optional config:
      // "options": {
      //   "maxAgeMs": 3600000,        // 1h default
      //   "cleanupIntervalMs": 600000  // 10min default
      // }
    }
  },

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

## Uninstall

Remove the `omo-watcher` entry from `plugins`, and the `prompt_append` lines from both `sisyphus` and `multimodal-looker` agents.

Also clean up saved images:

```bash
rm -rf .opencode/images/
```

## Config Options

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