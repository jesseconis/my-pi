# @jac/pi-snippets

Navigate and copy backtick-formatted content from assistant responses in the current Pi session branch.

## Usage

- `Ctrl+Shift+B`: open the latest snippet in a focused overlay.
- `Ctrl+Shift+J`: move to the next snippet and open it.
- `Ctrl+Shift+K`: move to the previous snippet and open it.
- `Ctrl+Shift+Y`: copy the current snippet without opening the overlay.
- `/snippets`: open the current snippet.
- `/snippets <number>`: open a specific snippet.
- `/snippets next`, `/snippets previous`, `/snippets copy`: command equivalents.

Inside the overlay:

- `j`/`k`, arrows, `n`/`p`, or `]`/`[` navigate snippets.
- Page Up/Page Down, `Ctrl+U`/`Ctrl+D`, Home/End scroll long snippets.
- `y` or `Ctrl+X` copies and keeps the overlay open.
- Enter copies and closes.
- Escape or `q` closes without copying.

Both fenced code blocks and inline code spans are included. Configure extraction and global shortcuts in `~/.pi/agent/snippets.json`. In this repository that path is linked to `agent/snippets.json` by `scripts/link-agent-config.sh`.

Pi 0.82.1 does not expose transcript scrolling to extensions. The overlay brings a selected snippet into view without mutating the session or replacing message renderers.
