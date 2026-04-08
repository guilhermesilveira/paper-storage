# paper-storage

`paper-storage` is a standalone CLI and TypeScript library for storing, indexing, extracting, and retrieving research papers from a git-backed repository.

## Goals

- installable as a global-style `paper-storage` command
- public-package-friendly, with no private keys or app-specific coupling
- strict TypeScript, linting, and test quality
- boring local subprocesses for `git`, `python3`, and related tools

## Commands

- `paper-storage setup`
- `paper-storage init`
- `paper-storage store`
- `paper-storage retrieve`
- `paper-storage move`
- `paper-storage list`

## Development

```bash
npm install
npm run lint
npm run test
npm run build
```

## Install locally

```bash
npm install
npm link
paper-storage --help
```

## Defaults

- managed tool home: `~/.local/paper-storage`
- managed venv: `~/.local/paper-storage/venv`
- default paper repo path: `~/.local/paper-storage/research-papers`

You can override these with `PAPER_STORAGE_HOME` and `PAPER_STORAGE_REPO_DIR`.
