# Zsh Power Features Quickstart

A practical tour of the built-in Zsh features that make the shell feel less like a command runner and more like a programmable workspace. Add the setup snippets to `~/.zshrc`, then restart the shell with `exec zsh` or reload with `source ~/.zshrc`.

> Tip: try risky expansions with `print -r -- ...` before using them with `rm`, `mv`, or `chmod`.

---

## 1. Smarter completions with `compinit` and `zstyle`

**What / why:** Zsh's completion system can complete commands, paths, options, Git branches, process IDs, environment variables, SSH hosts, and more. `zstyle` lets you tune menus, grouping, colors, and matching behavior.

**Configure / enable:**

```zsh
autoload -Uz compinit
compinit

zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'
zstyle ':completion:*' group-name ''
zstyle ':completion:*:descriptions' format '%F{yellow}-- %d --%f'
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}
```

**Usage examples:**

```zsh
git checkout <Tab>        # complete local/remote branches
ssh <Tab>                 # complete known hosts
kill <Tab>                # complete processes by PID/name
npm run <Tab>             # complete package scripts when available
cd ~/proj/myapp/src<Tab>  # case-insensitive path completion from matcher-list
```

Variants:

```zsh
# Rebuild completion cache if completions act stale.
rm -f ~/.zcompdump* && compinit

# Faster, less strict startup after the first secure compinit run.
autoload -Uz compinit
compinit -C
```

---

## 2. Command help with `run-help`

**What / why:** Press a key or run `run-help <command>` to open the relevant manual/help page without leaving the shell context.

**Configure / enable:**

```zsh
autoload -Uz run-help
alias help=run-help

# Optional: bind Alt-h to help for the current command line.
bindkey '^[h' run-help
```

**Usage examples:**

```zsh
help git
help zstyle
help compinit
```

Interactive variant:

```zsh
rsync --archive --verbose
# Put cursor on the command, then press Alt-h.
```

---

## 3. Powerful glob qualifiers

**What / why:** Zsh globs can filter files by type, age, size, permissions, owner, and sort order without calling `find`.

**Configure / enable:** Usually built in. Add these options for recursive and richer patterns:

```zsh
setopt EXTENDED_GLOB
setopt GLOB_DOTS       # include dotfiles in globs where appropriate
```

**Usage examples:**

```zsh
ls **/*.ts                 # recursive TypeScript files
ls **/*.log(.m-7)          # regular .log files modified in the last 7 days
ls **/*(.Lm+10)            # regular files larger than 10 MB
ls *(.)                    # regular files only
ls *(/)                    # directories only
ls *(*)                    # executable files only
ls **/*(.om[1,10])         # 10 newest regular files
ls **/*(.On[1,20])         # 20 smallest regular files
```

Safer destructive variant:

```zsh
print -r -- **/*.tmp(.m+30)  # preview temp files older than 30 days
rm -- **/*.tmp(.m+30)        # delete only after checking the preview
```

---

## 4. Extended glob patterns

**What / why:** Extended globbing adds regex-like operators for exclusions and alternatives directly in shell patterns.

**Configure / enable:**

```zsh
setopt EXTENDED_GLOB
```

**Usage examples:**

```zsh
ls ^node_modules            # everything except node_modules
ls *.md~README.md           # all Markdown files except README.md
ls *.(js|ts|tsx)            # JS/TS/TSX files
ls **/^(*.test).ts          # TypeScript files whose name does not include .test
ls (#i)readme.md            # case-insensitive match: README.md, readme.md, etc.
```

Variants:

```zsh
print -r -- **/*~**/dist/**~**/node_modules/**
# Everything recursively except files under dist or node_modules.
```

---

## 5. Batch rename with `zmv`

**What / why:** `zmv` performs safe pattern-based batch renames. It can preview changes before applying them.

**Configure / enable:**

```zsh
autoload -Uz zmv
alias mmv='noglob zmv -W'
alias mmvp='noglob zmv -nW'   # preview mode
```

**Usage examples:**

```zsh
zmv -n '(*).jpeg' '$1.jpg'        # preview .jpeg -> .jpg
zmv '(*).jpeg' '$1.jpg'           # apply

zmv -n 'IMG_(*).JPG' 'photo-$1.jpg'
zmv '(**/)(*).bak' '$1$2.backup'  # recursive rename, preserving directories
```

With `-W` aliases:

```zsh
mmvp '*.txt' '*.md'       # preview .txt -> .md
mmv '*.txt' '*.md'        # apply
```

---

## 6. Directory stack: `pushd`, `popd`, `dirs`, and `~N`

**What / why:** Keep a stack of directories and jump between them quickly. Great when working across several project folders.

**Configure / enable:**

```zsh
setopt AUTO_PUSHD          # cd pushes old dirs onto the stack
setopt PUSHD_IGNORE_DUPS   # do not duplicate stack entries
setopt PUSHD_SILENT        # less noisy cd/pushd output
```

**Usage examples:**

```zsh
cd ~/gh/app
cd ~/gh/api
cd /tmp

dirs -v                  # numbered directory stack
cd ~1                    # jump to stack entry 1
cd ~2                    # jump to stack entry 2
pushd ~/Downloads        # push and switch
popd                     # return to previous stack entry
```

Variants:

```zsh
alias d='dirs -v'
alias 1='cd ~1'
alias 2='cd ~2'
alias 3='cd ~3'
```

---

## 7. Named directories

**What / why:** Give long paths short names and use them anywhere a path is accepted.

**Configure / enable:** Add hash entries to `~/.zshrc`:

```zsh
hash -d gh=$HOME/gh
hash -d dl=$HOME/Downloads
hash -d cfg=$HOME/.config
```

**Usage examples:**

```zsh
cd ~gh/my-pi
ls ~dl
cp config.json ~cfg/myapp/config.json
print -r -- ~gh              # expands to /home/you/gh or similar
```

Variants:

```zsh
# Dynamic named directory from a variable.
project=$HOME/gh/my-pi
cd ~project
```

---

## 8. Suffix aliases

**What / why:** Open files by extension as if the file itself were executable. Useful for quick previews.

**Configure / enable:**

```zsh
alias -s md='${EDITOR:-nvim}'
alias -s txt='${EDITOR:-nvim}'
alias -s pdf='xdg-open'
alias -s png='xdg-open'
alias -s jpg='xdg-open'
```

On macOS, replace `xdg-open` with `open`.

**Usage examples:**

```zsh
README.md              # opens in $EDITOR
report.pdf             # opens in system PDF viewer
screenshot.png         # opens in image viewer
```

Variants:

```zsh
alias -s html='python3 -m webbrowser'
index.html
```

---

## 9. Global aliases

**What / why:** Global aliases expand anywhere on the command line, not just in command position. They are handy for common pipes and redirections.

**Configure / enable:**

```zsh
alias -g G='| grep -i'
alias -g L='| less -R'
alias -g H='| head'
alias -g T='| tail'
alias -g N='>/dev/null 2>&1'
alias -g C='| wc -l'
```

**Usage examples:**

```zsh
ps aux G node
journalctl -xe L
find . -type f C
make test N              # run quietly
```

Variants:

```zsh
alias -g J='| jq'
curl -s https://api.github.com/repos/zsh-users/zsh J '.stargazers_count'
```

---

## 10. History search and sharing

**What / why:** Make history deduplicated, shared across terminals, and searchable by prefix.

**Configure / enable:**

```zsh
HISTFILE=$HOME/.zsh_history
HISTSIZE=50000
SAVEHIST=50000

setopt APPEND_HISTORY
setopt SHARE_HISTORY
setopt HIST_IGNORE_DUPS
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_REDUCE_BLANKS
setopt HIST_VERIFY

bindkey '^R' history-incremental-search-backward
bindkey '^P' up-line-or-beginning-search
bindkey '^N' down-line-or-beginning-search
```

**Usage examples:**

```zsh
# Type a prefix, then press Ctrl-P / Ctrl-N.
git co<Ctrl-P>          # cycle previous commands beginning with "git co"

# Press Ctrl-R and type part of an old command.
<Ctrl-R> docker compose
```

Variants:

```zsh
fc -l -20               # show last 20 history entries
fc -s git=git           # rerun previous command after substitution
```

---

## 11. Line editor widgets with ZLE

**What / why:** Zsh's line editor can run custom widgets while you are typing commands. This enables custom keybindings, editing helpers, and interactive workflows.

**Configure / enable:** Example widget that treats the current command line as a directory name, creates it, enters it, and immediately accepts the line:

```zsh
mkcd-widget() {
  local dir=${BUFFER:-.}
  BUFFER="mkdir -p -- ${(q)dir} && cd -- ${(q)dir}"
  zle accept-line
}
zle -N mkcd-widget
bindkey '^X^M' mkcd-widget
```

**Usage examples:**

```zsh
# Type a path, then press Ctrl-X Ctrl-M.
projects/demo<Ctrl-X Ctrl-M>
# Runs: mkdir -p -- projects/demo && cd -- projects/demo
```

Variant that inserts the previous command at the cursor:

```zsh
insert-last-command() {
  LBUFFER+="$(fc -ln -1)"
}
zle -N insert-last-command
bindkey '^X^L' insert-last-command
```

---

## 12. `edit-command-line`

**What / why:** Open the current command line in your full editor, then return it to the prompt. Excellent for long pipelines, multiline commands, and careful quoting.

**Configure / enable:**

```zsh
autoload -Uz edit-command-line
zle -N edit-command-line
bindkey '^X^E' edit-command-line
```

**Usage examples:**

```zsh
# Start typing a long command, press Ctrl-X Ctrl-E, edit in $EDITOR, save/quit.
find . -type f -name '*.log' -mtime +30 -print0 | xargs -0 rm
```

Variants:

```zsh
export VISUAL=nvim
export EDITOR=nvim
```

---

## 13. Spell correction and command correction

**What / why:** Zsh can suggest corrections for mistyped commands, directories, and filenames.

**Configure / enable:**

```zsh
setopt CORRECT          # command correction
setopt CORRECT_ALL      # argument/path correction; more aggressive
```

If `CORRECT_ALL` feels too noisy, keep only `CORRECT`.

**Usage examples:**

```zsh
gti status              # zsh suggests: git status
cd /urs/local/bin       # zsh suggests: /usr/local/bin
```

Variants:

```zsh
alias cp='nocorrect cp'
alias mv='nocorrect mv'
alias mkdir='nocorrect mkdir'
```

---

## 14. Approximate matching in globs

**What / why:** Match filenames even when you are off by a character or two. Useful for typo-tolerant file discovery.

**Configure / enable:**

```zsh
setopt EXTENDED_GLOB
```

**Usage examples:**

```zsh
ls (#a1)readme.md       # allow one error: README.md, readme.md, redme.md
ls (#a2)*config*.json   # allow two errors in matching
```

Variants:

```zsh
print -r -- (#i)(#a1)license
# Case-insensitive and allows one typo.
```

---

## 15. Parameter expansion tricks

**What / why:** Zsh can transform variables without external tools like `basename`, `dirname`, `tr`, or `sed` for many common cases.

**Configure / enable:** Built in.

**Usage examples:**

```zsh
file=/tmp/archive.tar.gz
print ${file:t}          # archive.tar.gz, tail/basename
print ${file:h}          # /tmp, head/dirname
print ${file:e}          # gz, extension
print ${file:r}          # /tmp/archive.tar, remove one extension
print ${file:t:r}        # archive.tar

name='hello world'
print ${name:u}          # HELLO WORLD
print ${name:l}          # hello world
print ${name// /-}       # hello-world
```

Array variants:

```zsh
files=(src/main.ts README.md package.json)
print ${files:t}         # basenames of all entries
print ${(j:, :)files}    # join array with comma+space
print ${(u)files}        # unique values
```

---

## 16. Associative arrays

**What / why:** Use key/value maps directly in shell scripts and functions.

**Configure / enable:** Built in.

**Usage examples:**

```zsh
typeset -A ports
ports=(api 3000 web 5173 db 5432)

print $ports[api]
for service port in ${(kv)ports}; do
  print "$service listens on $port"
done
```

Variants:

```zsh
typeset -A colors=(error red warn yellow ok green)
print $colors[warn]
print ${(k)colors}       # keys
print ${(v)colors}       # values
```

---

## 17. Process substitution

**What / why:** Treat command output as a temporary file or stream. Useful for diffing, comparing, and feeding commands that require filenames.

**Configure / enable:** Built in on most systems.

**Usage examples:**

```zsh
diff <(sort old.txt) <(sort new.txt)
comm -12 <(sort a.txt) <(sort b.txt)
vimdiff <(git show HEAD~1:README.md) README.md
```

Output-process variant:

```zsh
tar cf >(gzip > backup.tar.gz) ./project
```

---

## 18. `multios`: redirect to multiple places

**What / why:** Zsh can redirect output to more than one file/process, similar to built-in `tee` behavior.

**Configure / enable:** Usually enabled by default, but you can be explicit:

```zsh
setopt MULTIOS
```

**Usage examples:**

```zsh
echo 'hello' > a.txt > b.txt
make test > test.log 2> error.log
print report > report.txt > >(wc -l)
```

Variants:

```zsh
# Append to multiple files.
printf '%s\n' done >> run.log >> audit.log
```

---

## 19. Prompt expansion and conditional prompts

**What / why:** Build informative prompts with colors, path shortening, status indicators, and command timing.

**Configure / enable:**

```zsh
setopt PROMPT_SUBST
autoload -Uz colors && colors

PROMPT='%F{cyan}%~%f %(?.%F{green}❯%f.%F{red}❯%f) '
RPROMPT='%F{244}%D{%H:%M:%S}%f'
```

**Usage examples:**

```zsh
~/gh/my-pi ❯ false
~/gh/my-pi ❯              # prompt arrow turns red after a failing command
```

Variants:

```zsh
# Show user@host only over SSH.
PROMPT='${SSH_CONNECTION:+%F{yellow}%n@%m%f }%F{cyan}%~%f %(?.❯.❯) '
```

---

## 20. Git-aware prompts with `vcs_info`

**What / why:** Built-in Git/SVN/Hg status metadata for prompts, without needing a prompt framework.

**Configure / enable:**

```zsh
autoload -Uz vcs_info
precmd() { vcs_info }

zstyle ':vcs_info:git:*' formats '(%b)'
zstyle ':vcs_info:git:*' actionformats '(%b|%a)'

setopt PROMPT_SUBST
PROMPT='%F{cyan}%~%f %F{magenta}${vcs_info_msg_0_}%f %(?.%F{green}❯%f.%F{red}❯%f) '
```

**Usage examples:**

```zsh
~/gh/my-pi (main) ❯ git switch -c docs/zsh-guide
~/gh/my-pi (docs/zsh-guide) ❯
```

Variants:

```zsh
# If prompt feels slow in very large repos, only call vcs_info under Git dirs.
precmd() {
  git rev-parse --is-inside-work-tree &>/dev/null && vcs_info || vcs_info_msg_0_=''
}
```

---

## 21. Hooks: `precmd`, `preexec`, `chpwd`

**What / why:** Run functions before each prompt, before each command, or after directory changes. Useful for timers, auto-activation, logging, and status updates.

**Configure / enable:**

```zsh
autoload -Uz add-zsh-hook

command_started() { timer=${EPOCHREALTIME} }
command_finished() {
  [[ -n $timer ]] || return
  local elapsed=$(( EPOCHREALTIME - timer ))
  (( elapsed > 5 )) && print -P "%F{yellow}took ${elapsed}s%f"
}

auto_ls_on_cd() { ls }

add-zsh-hook preexec command_started
add-zsh-hook precmd command_finished
# add-zsh-hook chpwd auto_ls_on_cd
```

**Usage examples:**

```zsh
sleep 6                  # after it finishes: "took 6.xs"
cd ~/Downloads           # if chpwd hook is enabled, runs ls automatically
```

Variants:

```zsh
# Auto-enable Python virtualenv named .venv when entering a project.
auto_venv() {
  [[ -f .venv/bin/activate ]] && source .venv/bin/activate
}
add-zsh-hook chpwd auto_venv
```

---

## 22. Modules with `zmodload`

**What / why:** Load optional Zsh modules for datetime, math, regex, curses, sockets, and more.

**Configure / enable:** Load only what you need:

```zsh
zmodload zsh/datetime
zmodload zsh/mathfunc
zmodload zsh/regex
```

**Usage examples:**

```zsh
print $EPOCHSECONDS
print $EPOCHREALTIME

zmodload zsh/mathfunc
print $(( sqrt(144) ))
print $(( sin(0.5) ))

zmodload zsh/regex
[[ 'release-2026-07' =~ 'release-[0-9]{4}-[0-9]{2}' ]] && print match
```

Variants:

```zsh
# See available modules.
zmodload -l
```

---

## 23. `zcalc`

**What / why:** A built-in calculator with shell-friendly syntax and math functions.

**Configure / enable:**

```zsh
autoload -Uz zcalc
```

**Usage examples:**

```zsh
zcalc
1 + 2 * 3
sqrt(2)
16#ff
```

One-shot variant:

```zsh
zcalc -e 'sqrt(144) + 10'
```

---

## 24. `zed`: quick file/function editor

**What / why:** Edit files or shell functions using a lightweight Zsh-provided editor command.

**Configure / enable:**

```zsh
autoload -Uz zed
```

**Usage examples:**

```zsh
zed ~/.zshrc             # edit a file
zed -f myfunc            # edit a loaded shell function
```

Variants:

```zsh
# After editing ~/.zshrc:
source ~/.zshrc
```

---

## 25. Safer shell options worth enabling

**What / why:** Zsh options can prevent common mistakes and make shell behavior more ergonomic.

**Configure / enable:**

```zsh
setopt NO_CLOBBER        # do not overwrite files with > by accident
setopt INTERACTIVE_COMMENTS
setopt AUTO_CD           # type directory name to cd into it
setopt CDABLE_VARS       # cd into named variables/directories
setopt LONG_LIST_JOBS
setopt NOTIFY
```

**Usage examples:**

```zsh
echo new > existing.txt  # blocked when NO_CLOBBER is set
echo new >| existing.txt # explicit override

/tmp                    # with AUTO_CD, same as: cd /tmp
project=$HOME/gh/my-pi
cd project              # with CDABLE_VARS, cd to $project
sleep 10 &              # job status reported promptly with NOTIFY
```

Variants:

```zsh
unsetopt BEEP            # silence terminal bell
setopt NO_NOMATCH        # leave unmatched globs unchanged; useful for scp/curl URLs
```

---

## Minimal starter `~/.zshrc`

```zsh
# Completion
autoload -Uz compinit run-help edit-command-line zmv zcalc zed
compinit
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'

# Editing
zle -N edit-command-line
bindkey '^X^E' edit-command-line
bindkey '^R' history-incremental-search-backward

# Options
setopt EXTENDED_GLOB GLOB_DOTS AUTO_PUSHD PUSHD_IGNORE_DUPS
setopt APPEND_HISTORY SHARE_HISTORY HIST_IGNORE_ALL_DUPS HIST_REDUCE_BLANKS
setopt PROMPT_SUBST INTERACTIVE_COMMENTS AUTO_CD NO_CLOBBER

# History
HISTFILE=$HOME/.zsh_history
HISTSIZE=50000
SAVEHIST=50000

# Named dirs
hash -d gh=$HOME/gh
hash -d dl=$HOME/Downloads
hash -d cfg=$HOME/.config

# Aliases
alias help=run-help
alias mmv='noglob zmv -W'
alias mmvp='noglob zmv -nW'
alias -g G='| grep -i'
alias -g L='| less -R'

# Prompt
autoload -Uz colors && colors
PROMPT='%F{cyan}%~%f %(?.%F{green}❯%f.%F{red}❯%f) '
```

## Quick troubleshooting

```zsh
zsh --version             # verify installed Zsh version
emulate -L zsh            # use native Zsh behavior inside a function
setopt                    # show enabled options
unsetopt OPTION_NAME      # disable an option
which compinit            # confirm autoloaded function location
type mycommand            # see whether a name is alias/function/builtin/external
```
