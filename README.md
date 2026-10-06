# Claude Code mods

Small mods that change how [Claude Code](https://claude.com/claude-code) behaves, one folder each. They work in the terminal and in the desktop app's Code tab.

| Mod | What it does | Platform |
| --- | --- | --- |
| [dictation-music](mods/dictation-music) | Pauses your music while you dictate a prompt and resumes it once you hit Enter. Works with any dictation app and any music app, and leaves meetings alone. | macOS |

## What's a mod?

A mod is a Claude Code plugin made of *function hooks*: a TypeScript module that Claude Code loads into the session and calls when things happen, such as a session starting, a prompt being submitted or Claude taking a step. Mods can add slash commands, show notices and run local helpers. The module itself has no direct file, process or network access: it goes through Claude Code's API for those.

Each folder under `mods/` is one self-contained mod with its own README.

## Install a mod

1. Clone this repository once:

   ```bash
   git clone https://github.com/yash-coded/claude-code-mods ~/.claude/claude-code-mods
   ```

2. Add the mods you want to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` section of `~/.claude/settings.json`. Separate several mods with `:`:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/claude-code-mods/mods/dictation-music"
     }
   }
   ```

3. Start a new Claude Code session. In the desktop app, quit and reopen it once so it picks up the setting.

Check each mod's README for anything else it needs.

To update, pull the latest changes and start a new session:

```bash
git -C ~/.claude/claude-code-mods pull
```

## Developing a mod

```
mods/<name>/
  .claude-plugin/plugin.json   name, version, description
  hooks/hooks.json             { "modules": ["./register.ts"] }
  hooks/register.ts            export const register: Register = on => { ... }
  tests/*.test.ts              run with `claude plugin test`
  README.md
```

From the mod's folder:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

Claude Code writes type definitions into `.claude-plugin/types/` the first time it loads a mod, and the mod's `tsconfig.json` points at them. After that you can type-check:

```bash
npx -p typescript tsc -p .
```

To try a mod without changing your settings, start a session with `claude --plugin-dir mods/<name>`.

## License

[MIT](LICENSE)
