# Studio Style Skills

Agent skills that reproduce the interface of [Prime Agent Studio](https://github.com/zerr0o/prime-agent-studio).

| Skill | What it does |
|---|---|
| [`prime-agent-studio-style`](prime-agent-studio-style/SKILL.md) | Design or restyle an app so it looks and reads like Prime Agent Studio: exact color tokens (dark and light), type scale, app shell, components, 56 line icons, interface copy, and patterns for apps that drive several Studio instances through the Studio public API v1. |

The skill ships a ready CSS kit (`assets/studio.css`), the icons (`icons.js`, `icons.esm.js`, `icons.svg`), a complete workspace example, a component gallery and screenshots of the real app. Open `prime-agent-studio-style/assets/example-shell.html` and `components.html` in a browser to see the result: they work straight from disk (add `?theme=light` for the light theme).

## Install

A skill is a folder with a `SKILL.md`. Copy the whole `prime-agent-studio-style` folder (not only `SKILL.md`) into the skills folder of your agent:

| Agent | Personal (all projects) | One project only |
|---|---|---|
| Prime Agent | `~/.prime/agent/skills/` or `~/.agents/skills/` | `<project>/.prime/agent/skills/` |
| Codex | `~/.agents/skills/` | `<project>/.agents/skills/` |
| Claude Code | `~/.claude/skills/` | `<project>/.claude/skills/` |

Windows example (PowerShell):

```powershell
Copy-Item -Recurse .\prime-agent-studio-style "$HOME\.agents\skills\"
```

Start a new session (or `/reload` in Prime Agent). The agent loads the skill when a request matches its description, for example "build this dashboard in the Prime Agent Studio style". You can also name it explicitly: "use the prime-agent-studio-style skill".

An agent without skill support can still use it: give it the path of `SKILL.md` and ask it to follow it.

## Contents

```
prime-agent-studio-style/
  SKILL.md                 entry point: quick start, 12 rules, file map
  assets/                  studio.css, icons.js, icons.esm.js, icons.svg, theme.js, logo,
                           example-shell.html, components.html
  references/              tokens, typography, layout, components, writing, icons and brand,
                           multi-instance apps, review checklist, screenshots
```

Values come from Prime Agent Studio 4.3.2. When Studio changes its look, update `assets/studio.css` first, then the references.

## En français

Ce dépôt contient un skill d'agent qui reproduit fidèlement la charte graphique de Prime Agent Studio : couleurs exactes des thèmes sombre et clair, typographie, structure de l'application, composants, icônes et règles de rédaction de l'interface. Il couvre aussi les applications qui pilotent plusieurs instances de Studio avec l'API publique v1.

Installation : copiez le dossier complet `prime-agent-studio-style` dans le dossier de skills de votre agent (tableau ci-dessus), puis ouvrez une nouvelle session. Demandez par exemple : « Crée cette interface avec la charte graphique de Prime Agent Studio ». Le contenu du skill est en anglais pour fonctionner avec tous les agents ; l'interface produite peut être en français ou en anglais (voir `references/writing.md`).

## License

MIT, (c) 2026 zerr0o. See [LICENSE](LICENSE). Segoe UI is a Microsoft system font and is not included.
