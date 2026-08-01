# Tracked Pi configuration

These JSON files are the source of truth for safe, version-controlled Pi configuration.

Run from anywhere:

```sh
/home/jesse/gh/my-pi/scripts/link-agent-config.sh
```

The script backs up existing files and links every tracked `agent/*.json` file into `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`. Pi continues to keep credentials, sessions, trust decisions, model caches, and other runtime state under `~/.pi/agent`; those files are not linked or committed.

After changing a tracked file, run `/reload` in Pi. Changes made by Pi itself to a linked `settings.json` are written through the symlink and appear as changes in this repository.

## Terminal shortcut ownership

A terminal or multiplexer binding wins before Pi can inspect a key. The current `~/.wezterm.lua` binds `Alt+h/j/k/l` to `ActivatePaneDirection`, so those four chords must be removed or changed there before the matching bindings in `keybindings.json` can work. Likewise, tmux `bind -n M-h/M-j/M-k/M-l` entries intercept the chords when Pi runs inside tmux. `Alt+b/w` already work because neither layer claims them.

Do not add `auth.json`, `trust.json`, `models-store.json`, session files, logs, or credentials here.
