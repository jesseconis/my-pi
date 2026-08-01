# `zshcontrib` Quickstart: Noteworthy Contributed Zsh Features

This guide is based on `man zshcontrib`: the community-contributed functions shipped with many Zsh installs. Most are not shell builtins; they are autoloadable functions living somewhere in your `$fpath`.

Quick checks:

```zsh
print -l $fpath              # directories zsh searches for autoloadable functions
whence -w run-help cdr zmv   # see whether a function is available
autoload -Uz FUNCTION        # standard way to load contributed functions
```

Add setup snippets to `~/.zshrc`, then run `source ~/.zshrc` or start a new shell.

---

## 1. Better online help: `run-help`

**What / why:** Replaces the default `run-help` alias to `man` with a smarter function that understands shell builtins, functions, and helper functions like `run-help-git`, `run-help-sudo`, etc. Usually invoked with `Esc h` on the current command line.

**Configure / enable:**

```zsh
unalias run-help 2>/dev/null
autoload -Uz run-help

# Optional command-specific helpers, if installed.
autoload -Uz run-help-git run-help-sudo run-help-openssl 2>/dev/null

# Usually already bound, but harmless if you want it explicit.
bindkey '^[h' run-help
```

**Usage:**

```zsh
run-help print          # help for zsh's print builtin
run-help zstyle         # help for zstyle
run-help git commit     # with run-help-git, opens relevant git help
```

Interactive variant:

```zsh
git rebase --interactive HEAD~3
# Put cursor on the line and press Esc h.
```

---

## 2. Hook management: `add-zsh-hook` and `add-zle-hook-widget`

**What / why:** Safely register multiple functions for shell lifecycle hooks (`precmd`, `preexec`, `chpwd`, etc.) or line-editor hooks without overwriting someone else's hook function.

**Configure / enable:**

```zsh
autoload -Uz add-zsh-hook add-zle-hook-widget
```

**Usage:**

```zsh
command_timer_start() { timer=${EPOCHREALTIME} }
command_timer_stop() {
  [[ -n $timer ]] || return
  local elapsed=$(( EPOCHREALTIME - timer ))
  (( elapsed > 5 )) && print -P "%F{yellow}took ${elapsed}s%f"
}

add-zsh-hook preexec command_timer_start
add-zsh-hook precmd  command_timer_stop
```

Variants:

```zsh
add-zsh-hook -L                         # list current shell hooks
add-zsh-hook -d precmd command_timer_stop

on_keymap_change() { zle -R "keymap: $KEYMAP" }
zle -N on_keymap_change
add-zle-hook-widget keymap-select on_keymap_change
```

---

## 3. Persistent recent directories: `cdr`

**What / why:** Like a smarter, persistent directory stack. Zsh remembers directories you visit across shells and lets you jump back by number.

**Configure / enable:**

```zsh
autoload -Uz chpwd_recent_dirs cdr add-zsh-hook
add-zsh-hook chpwd chpwd_recent_dirs

# Nice completion for cdr numbers.
autoload -Uz compinit && compinit
zstyle ':completion:*:*:cdr:*:*' menu selection

# Optional tuning.
zstyle ':chpwd:*' recent-dirs-max 50
zstyle ':chpwd:*' recent-dirs-prune parent 'pattern:/tmp(|/*)'
```

**Usage:**

```zsh
cd ~/gh/my-pi
cd /tmp
cd ~/Downloads

cdr -l        # list remembered dirs
cdr           # jump to most recent previous dir
cdr 2         # jump to entry 2
cdr -e        # edit the list
cdr -p '/tmp(|/*)'   # prune /tmp entries, with confirmation
```

Variants:

```zsh
# Make cdr behave like cd for non-numeric arguments.
zstyle ':chpwd:*' recent-dirs-default true
alias cd=cdr

# Dynamic names for recent dirs: ~[1], ~[2], etc.
autoload -Uz add-zsh-hook
add-zsh-hook -Uz zsh_directory_name zsh_directory_name_cdr
cd ~[1]
```

---

## 4. Abbreviated dynamic directory names: `zsh_directory_name_generic`

**What / why:** Create compact path aliases like `~[gh:pi]` or `~[gh:api:src]` with completion and reverse expansion support.

**Configure / enable:**

```zsh
autoload -Uz add-zsh-hook zsh_directory_name_generic

zdn_projects() {
  local -A zdn_top=(
    gh  "$HOME/gh/:projects"
    cfg "$HOME/.config"
  )
  local -A projects=(
    pi  my-pi
    api work/api
    web work/web
  )
  zsh_directory_name_generic "$@"
}

add-zsh-hook zsh_directory_name zdn_projects
```

**Usage:**

```zsh
cd ~[gh:pi]        # -> $HOME/gh/my-pi
ls ~[gh:api]       # -> $HOME/gh/work/api
vim ~[cfg]/nvim/init.lua
```

Variants:

```zsh
print -r -- ~[gh:<Tab>     # complete dynamic components
print -r -- ~[cfg]         # top-level mappings can be used alone
```

---

## 5. VCS-aware prompts: `vcs_info`

**What / why:** Built-in Git/Hg/SVN/etc. repository metadata for prompts, with no prompt framework required.

**Configure / enable:**

```zsh
autoload -Uz vcs_info
setopt PROMPT_SUBST

# Keep it fast by enabling only systems you actually use.
zstyle ':vcs_info:*' enable git hg svn
zstyle ':vcs_info:*' formats '(%s:%b)'
zstyle ':vcs_info:*' actionformats '(%s:%b|%a)'
zstyle ':vcs_info:git:*' check-for-changes true
zstyle ':vcs_info:git:*' stagedstr '+'
zstyle ':vcs_info:git:*' unstagedstr '!'

precmd() { vcs_info }
PROMPT='%F{cyan}%~%f %F{magenta}${vcs_info_msg_0_}%f %# '
```

**Usage:**

```zsh
cd ~/gh/my-pi
# Prompt shows something like: ~/gh/my-pi (git:main) %

git switch -c docs/zshcontrib
# Prompt updates to: (git:docs/zshcontrib)
```

Variants:

```zsh
vcs_info_printsys       # list supported/disabled VCS backends
vcs_info_lastmsg        # print the last formatted VCS message

# Disable slow/unused backends instead of using enable.
zstyle ':vcs_info:*' disable bzr cdv darcs mtn svk tla
```

---

## 6. Built-in prompt themes: `promptinit` and `prompt`

**What / why:** Zsh ships a small prompt theme system. You can list, preview, activate, and write themes without installing Oh My Zsh or another framework.

**Configure / enable:**

```zsh
autoload -Uz promptinit
promptinit
```

**Usage:**

```zsh
prompt -l              # list available themes
prompt -p              # preview all themes
prompt -p adam1        # preview one theme
prompt adam1           # activate for this shell
prompt -s adam1        # activate and save theme state
prompt -c              # show current theme
prompt restore         # restore pre-theme prompt
```

Variants:

```zsh
# Put in ~/.zshrc after promptinit.
prompt adam1

# Theme help, where available.
prompt -h adam1
```

---

## 7. Keyboard discovery: `zkbd`

**What / why:** Detects what escape sequences your terminal sends for keys like arrows, Home/End, Insert/Delete, and writes them to a reusable `$key` associative array.

**Configure / enable:**

```zsh
autoload -Uz zkbd
zkbd             # follow prompts; writes ${ZDOTDIR:-$HOME}/.zkbd/...
```

Then source the generated file in `~/.zshrc`:

```zsh
zkbd_file=${ZDOTDIR:-$HOME}/.zkbd/$TERM-$VENDOR-$OSTYPE
[[ -r $zkbd_file ]] && source $zkbd_file

[[ -n ${key[Left]}  ]] && bindkey "${key[Left]}"  backward-char
[[ -n ${key[Right]} ]] && bindkey "${key[Right]}" forward-char
[[ -n ${key[Home]}  ]] && bindkey "${key[Home]}"  beginning-of-line
[[ -n ${key[End]}   ]] && bindkey "${key[End]}"   end-of-line
[[ -n ${key[Delete]} ]] && bindkey "${key[Delete]}" delete-char
```

**Usage:**

```zsh
bindkey "${key[Up]}" up-line-or-beginning-search
bindkey "${key[Down]}" down-line-or-beginning-search
```

Variants:

```zsh
print -rl ${(kv)key}    # inspect detected key names/sequences
```

---

## 8. Faster function loading: `zrecompile`

**What / why:** Keeps compiled `.zwc` function digests up to date. Useful if you maintain many custom autoload functions or care about startup/function-load speed.

**Configure / enable:**

```zsh
autoload -Uz zrecompile
```

**Usage:**

```zsh
zrecompile              # check existing .zwc files in $fpath
zrecompile -q           # quieter
zrecompile -t           # test only; status says whether recompilation is needed
```

Variants:

```zsh
# Compile specific startup/completion files.
zrecompile -p \
  -R ~/.zshrc -- \
  -M ~/.zcompdump

# Recompile a custom function digest.
zrecompile ~/zsh/functions.zwc
```

---

## 9. Shell-state reports: `reporter`

**What / why:** Dumps aliases, options, variables, key bindings, styles, etc. as reproducible shell code. Useful for debugging Zsh problems or auditing your config.

**Configure / enable:** Often not in `$fpath`; source it from a Zsh source/install path if available.

```zsh
# Example path depends on how zsh was installed.
. /usr/share/zsh/*/Util/reporter > zsh.report
```

**Usage:**

```zsh
reporter aliases options zstyles > zsh-minimal.report
reporter bindings > zsh-bindings.report
```

Variants:

```zsh
# Always review for secrets before sharing.
$EDITOR zsh.report
```

---

## 10. Edit the current command in `$EDITOR`: `edit-command-line`

**What / why:** Opens your current prompt buffer in a real editor. Great for long pipelines, quoting-heavy commands, or multiline shell snippets.

**Configure / enable:**

```zsh
autoload -Uz edit-command-line
zle -N edit-command-line
bindkey '^X^E' edit-command-line

# Optional: choose editor specifically for this widget.
zstyle ':zle:edit-command-line' editor ${VISUAL:-${EDITOR:-vi}}
```

**Usage:**

```zsh
# Type a long command, press Ctrl-X Ctrl-E, edit, save, quit.
find . -type f -name '*.log' -mtime +30 -print0 | xargs -0 rm
```

Variants:

```zsh
# Vi command mode style binding.
bindkey -M vicmd v edit-command-line
```

---

## 11. Better history widgets

**What / why:** `zshcontrib` includes several history search widgets that are more ergonomic than plain up/down arrows.

**Configure / enable:**

```zsh
autoload -Uz history-search-end history-beginning-search-menu history-pattern-search

zle -N history-beginning-search-backward-end history-search-end
zle -N history-beginning-search-forward-end  history-search-end
zle -N history-beginning-search-menu-space-end history-beginning-search-menu
zle -N history-pattern-search-backward history-pattern-search
zle -N history-pattern-search-forward  history-pattern-search

bindkey '^[p' history-beginning-search-backward-end
bindkey '^[n' history-beginning-search-forward-end
bindkey '^[m' history-beginning-search-menu-space-end
bindkey '^[/' history-pattern-search-backward
```

**Usage:**

```zsh
git sw<Esc-p>       # find previous history line beginning with "git sw"
<Esc-m> docker ps   # numbered menu of matching history lines
<Esc-/> '^ssh .*prod'  # pattern-search history backward
```

Variants:

```zsh
# With the menu-space-end widget, spaces act like wildcards.
# Searching "git main" can match "git checkout main".
```

---

## 12. Bash-like or custom word movement: `select-word-style`

**What / why:** Changes what ZLE considers a “word” for movement/deletion. Especially useful if you prefer Bash-style word behavior where punctuation breaks words.

**Configure / enable:**

```zsh
autoload -Uz select-word-style
select-word-style bash
```

**Usage:**

```zsh
# Alt-f / Alt-b / Alt-d now treat punctuation as boundaries more like Bash.
foo-bar/baz_qux
# Cursor movement stops around -, /, etc. depending on selected style.
```

Variants:

```zsh
select-word-style normal       # zsh default-ish behavior
select-word-style shell        # shell arguments are words
select-word-style whitespace   # whitespace-delimited words

# Per-widget custom style: make backward-kill-word delete space-delimited chunks.
zle -N backward-kill-space-word backward-kill-word-match
zstyle ':zle:backward-kill-space-word' word-style whitespace
bindkey '^[^?' backward-kill-space-word
```

---

## 13. URL-safe typing and pasting: `url-quote-magic` + `bracketed-paste-magic`

**What / why:** Automatically quotes shell metacharacters in URLs as you type or paste, reducing broken `curl`, `wget`, and browser commands.

**Configure / enable:**

```zsh
autoload -Uz url-quote-magic bracketed-paste-magic
zle -N self-insert url-quote-magic
zle -N bracketed-paste bracketed-paste-magic

# Helpful with url-quote-magic when pasting into the middle/end of a URL word.
zstyle ':bracketed-paste-magic' paste-init backward-extend-paste
```

**Usage:**

```zsh
curl https://example.com/search?q=a b&debug=true
# As you type/paste, spaces, &, ?, etc. can be quoted so the shell keeps one URL.
```

Variants:

```zsh
# Commands that should handle URL globbing themselves.
zstyle ':url-quote-magic' url-globbers noglob globurl

# Treat extra schemes as URLs.
zstyle ':urlglobber' url-other-schema http https ftp ssh
```

---

## 14. Smarter insertion from previous commands

**What / why:** `smart-insert-last-word` and `copy-earlier-word` make it easier to pull useful words from history without cycling through junk like redirections or comments.

**Configure / enable:**

```zsh
autoload -Uz smart-insert-last-word copy-earlier-word
zle -N insert-last-word smart-insert-last-word
zle -N copy-earlier-word
bindkey '^[.' insert-last-word
bindkey '^[,' copy-earlier-word
```

**Usage:**

```zsh
mkdir -p src/components/Button
cd <Alt-.>        # inserts src/components/Button

cp src/a.ts src/b.ts
vim <Alt-,>       # repeated Alt-, cycles earlier words from the relevant line
```

Variants:

```zsh
# Define what counts as "interesting".
zstyle ':insert-last-word' match '*[[:alpha:]/\\]*'

# Insert last assignment-looking word with Alt-=.
zle -N insert-last-assignment smart-insert-last-word
zstyle ':insert-last-assignment' match '[[:alpha:]_][[:alnum:]_]#=*'
bindkey '^[=' insert-last-assignment
```

---

## 15. Edit/transform the current command line

**What / why:** Replace text, modify the argument under the cursor, or temporarily narrow editing to a selected region.

**Configure / enable:**

```zsh
autoload -Uz replace-string replace-argument narrow-to-region narrow-to-region-invisible

zle -N replace-string
zle -N replace-pattern replace-string
zle -N replace-string-again
zle -N replace-argument
zle -N replace-argument-edit replace-argument
zle -N narrow-to-region-invisible

bindkey '^Xr' replace-string
bindkey '^Xp' replace-pattern
bindkey '^Xa' replace-argument-edit
bindkey '^Xn' narrow-to-region-invisible
```

**Usage:**

```zsh
print This line contains fan and fond
# Press Ctrl-X p, source pattern: f(?)n, replacement: c\1r
# Result: print This line contains car and cord

curl 'https://old.example/api'
# Put cursor on the URL, press Ctrl-X a, edit just that argument.
```

Variants:

```zsh
# In a custom widget, uppercase the argument under cursor.
autoload -Uz modify-current-argument
uppercase-arg() { modify-current-argument '${(U)ARG}' }
zle -N uppercase-arg
bindkey '^Xu' uppercase-arg
```

---

## 16. Insert helpers: `incarg`, `insert-files`, `insert-unicode-char`, `insert-composed-char`

**What / why:** Small widgets for common editing chores: increment numbers, interactively expand file globs into the line, and insert characters not on your keyboard.

**Configure / enable:**

```zsh
autoload -Uz incarg insert-files insert-unicode-char insert-composed-char
zle -N incarg
zle -N insert-files
zle -N insert-unicode-char
zle -N insert-composed-char

bindkey '^X+' incarg
bindkey '^Xf' insert-files
bindkey '^XU' insert-unicode-char
bindkey '^Xc' insert-composed-char
```

**Usage:**

```zsh
version=41        # cursor on 41, press Ctrl-X + -> version=42

vim <Ctrl-X f>    # type **/*.md, see expansions, Enter inserts matches

<Ctrl-X U> 2 0 a c <Ctrl-X U>   # inserts € (U+20AC)
<Ctrl-X c> a :                  # inserts ä
```

Variants:

```zsh
incarg=10         # Ctrl-X + increments by 10 by default
# Or use a numeric argument to increment/decrement by another amount.
```

---

## 17. Predictive and incremental completion: `predict-on`, `incremental-complete-word`

**What / why:** Completion/history feedback as you type. Powerful, but best with conservative completer settings because it can run often.

**Configure / enable:**

```zsh
autoload -Uz compinit predict-on incremental-complete-word
compinit

zle -N predict-on
zle -N predict-off
zle -N incremental-complete-word

bindkey '^X^Z' predict-on
bindkey '^Z' predict-off
bindkey '^Xi' incremental-complete-word

# Keep prediction cheap.
zstyle ':completion:predict:*' completer _complete
zstyle ':predict' toggle true
zstyle ':predict' verbose true
```

**Usage:**

```zsh
<Ctrl-X Ctrl-Z>    # turn on predictive typing
ssh pro            # line may complete from history/completion
<Ctrl-Z>           # turn prediction off

<Ctrl-X i>         # start incremental completion for current word
```

Variants:

```zsh
zstyle ':completion:incremental:*' completer _complete _correct
zstyle ':incremental' prompt '%c %n matches %u %s'
```

---

## 18. Calculator and math functions: `zcalc`, `zmathfunc`, `zmathfuncdef`

**What / why:** A capable calculator using Zsh arithmetic, with history, variables, output formats, RPN mode, and definable math functions.

**Configure / enable:**

```zsh
autoload -Uz zcalc zmathfunc zmathfuncdef
```

**Usage:**

```zsh
zcalc
1 + 2 * 3
3 / 4          # integer arithmetic unless float mode is used
:q

zcalc -f       # floating point mode
zcalc -e 'sqrt(144) + 10'
zcalc '-#16' -e '255'    # output base 16; quote # if needed
```

Variants:

```zsh
zcalc -r       # RPN mode
# Then enter:
# 2
# 3
# +

zmathfunc      # defines min(), max(), sum()
print $(( max(3, 7, 4) ))

zmathfuncdef cube '$1 * $1 * $1'
print $(( cube(5) ))
```

---

## 19. MIME/file extension dispatch: `zsh-mime-setup` and `pick-web-browser`

**What / why:** Execute files by extension and dispatch them to viewers using mailcap/mime rules or your own `zstyle` handlers.

**Configure / enable:**

```zsh
autoload -Uz zsh-mime-setup

# Define overrides before setup.
zstyle ':mime:.txt:' handler 'less %s'
zstyle ':mime:.txt:' flags needsterminal
zstyle ':mime:.md:'  handler '${EDITOR:-vi} %s'
zstyle ':mime:*' disown true

zsh-mime-setup
```

**Usage:**

```zsh
README.md        # opens in $EDITOR
notes.txt        # opens in less
zsh-mime-setup -l
zsh-mime-handler -l README.md   # show command that would be executed
```

Variants:

```zsh
autoload -Uz pick-web-browser
alias -s html=pick-web-browser
zstyle ':mime:*' browser-style running x tty
zstyle ':mime:*' x-browsers firefox chromium google-chrome
zstyle ':mime:*' tty-browsers lynx links elinks

index.html
```

---

## 20. Exception-like control flow: `throw` and `catch`

**What / why:** Structured error handling for shell functions/scripts, used with Zsh's `always` block.

**Configure / enable:**

```zsh
autoload -Uz throw catch
```

**Usage:**

```zsh
parse_config() {
  [[ -r $1 ]] || throw ConfigMissing
  print "reading $1"
}

unset EXCEPTION
{
  parse_config ./app.conf
} always {
  if catch ConfigMissing; then
    print -u2 'Config file is missing'
  elif catch ''; then
    print -u2 'A shell error occurred; rethrowing'
    throw ''
  fi
}
```

Variants:

```zsh
{
  throw NetworkTimeout
} always {
  if catch 'Network*'; then
    print "caught $CAUGHT"
  fi
}
```

---

## 21. Safer huge argument lists: `zargs`

**What / why:** Like `xargs`, but takes input from Zsh's command-line expansions. Great with recursive globs that might exceed external command length limits.

**Configure / enable:**

```zsh
autoload -Uz zargs
setopt EXTENDED_GLOB
```

**Usage:**

```zsh
zargs -- **/*(.) -- ls -ld --
# Long listing of all regular files below current dir.

zargs -r -- ./*.back(#qN) -- rm -f --
# Remove backups only if the glob matched something.
```

Variants:

```zsh
# Process in batches of 50 total args per command invocation.
zargs -n 50 -- **/*.jpg -- jpegoptim --strip-all --

# Use a different end marker when -- may appear in input.
zargs -e.. -- **/*(.) .. ls -ld --
```

---

## 22. ZLE-based file/function/history editor: `zed`

**What / why:** Edit a file, a loaded function, or shell history from inside Zsh using ZLE. Handy on minimal systems or for editing live functions.

**Configure / enable:**

```zsh
autoload -Uz zed
zed -b          # optional: install zed-specific keymaps/bindings
```

**Usage:**

```zsh
zed ~/.zshrc        # edit a file
zed scratch.txt     # create/edit a file
zed -f myfunc       # edit function myfunc in current shell
zed -h              # edit current shell history
```

Variants:

```zsh
# If available/linked in your fpath:
fned myfunc         # same idea as zed -f myfunc
histed              # same idea as zed -h
```

---

## 23. Pattern batch rename/copy/link: `zmv`, `zcp`, `zln`

**What / why:** Rename many files using Zsh patterns, with dry-run support and collision checks. `zcp` and `zln` are `zmv` variants for copy/link if installed/linked.

**Configure / enable:**

```zsh
autoload -Uz zmv
alias mmv='noglob zmv -W'
alias mmvp='noglob zmv -nW'
```

**Usage:**

```zsh
zmv -n '(*).jpeg' '$1.jpg'        # preview
zmv    '(*).jpeg' '$1.jpg'        # apply

zmv -v '(* *)' '${1// /_}'        # replace spaces with underscores
zmv -v '* *' '${f// /_}'          # same, using $f for full source name
```

Variants:

```zsh
mmvp '*.txt' '*.md'               # preview wildcard-to-wildcard rename
mmv  '*.txt' '*.md'

zmv -C '(*).conf' '$1.conf.bak'   # copy instead of move
zmv -L '(*).conf' '$1.conf.link'  # hard-link instead of move
zmv -i '(*).png' 'image-$1.png'   # ask per file
```

---

## 24. Useful misc helpers: `colors`, `is-at-least`, `regexp-replace`, `which-command`

**What / why:** Small functions that smooth over prompt colors, version checks, regex replacements, and command introspection from the line editor.

**Configure / enable:**

```zsh
autoload -Uz colors is-at-least regexp-replace which-command
colors

zle -N which-command
bindkey '^[?' which-command
```

**Usage:**

```zsh
print "${fg[red]}error${reset_color}"

is-at-least 5.9 && print 'modern enough'
is-at-least 5.10 || print 'older than 5.10'

text='one two two three'
regexp-replace text 'two' 'TWO'
print $text             # one TWO TWO three
```

Interactive variant:

```zsh
# Type a command, then press Alt-? to see what will actually execute.
ll /tmp<Alt-?>          # traces aliases better than the builtin widget
```

---

## 25. Bonus: yes, Zsh ships Tetris

**What / why:** Not practical, but memorable. The `tetris` function is a ZLE widget; `tetriscurses` is a curses version.

**Configure / enable:**

```zsh
autoload -Uz tetris
zle -N tetris
bindkey '^Xt' tetris

# Or curses version:
autoload -Uz tetriscurses
```

**Usage:**

```zsh
# Press Ctrl-X t to play/continue ZLE Tetris; q quits.
tetriscurses     # launch curses version
```

---

## Minimal starter config

```zsh
# Core contributed helpers
autoload -Uz run-help add-zsh-hook cdr chpwd_recent_dirs vcs_info promptinit zmv zargs zed zcalc colors
unalias run-help 2>/dev/null
colors

# Completion, useful for cdr/zcalc/zed/etc.
autoload -Uz compinit
compinit
zstyle ':completion:*' menu select

# Recent dirs
autoload -Uz chpwd_recent_dirs cdr
add-zsh-hook chpwd chpwd_recent_dirs
zstyle ':completion:*:*:cdr:*:*' menu selection
zstyle ':chpwd:*' recent-dirs-max 50

# VCS prompt
setopt PROMPT_SUBST
zstyle ':vcs_info:*' enable git hg svn
zstyle ':vcs_info:*' formats '(%s:%b)'
zstyle ':vcs_info:*' actionformats '(%s:%b|%a)'
precmd() { vcs_info }
PROMPT='%F{cyan}%~%f %F{magenta}${vcs_info_msg_0_}%f %# '

# ZLE conveniences
autoload -Uz edit-command-line history-search-end smart-insert-last-word url-quote-magic bracketed-paste-magic
zle -N edit-command-line
zle -N insert-last-word smart-insert-last-word
zle -N self-insert url-quote-magic
zle -N bracketed-paste bracketed-paste-magic
bindkey '^X^E' edit-command-line
bindkey '^[.' insert-last-word

# Batch rename aliases
autoload -Uz zmv
alias mmv='noglob zmv -W'
alias mmvp='noglob zmv -nW'
```
