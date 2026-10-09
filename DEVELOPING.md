# Development

A guide of developing `vscode-clangd` extension.

## Requirements

* VS Code
* Node.js 20 and npm
* CMake and Ninja when building the uC++ clangd backend

## uC++ backend quick start

For the simplest setup, clone the repositories beside each other:

```text
development/
├── llvm-project/
└── vscode-clangd/
```

Then run this from `vscode-clangd`:

```bash
npm ci
npm run dev:all
```

This configures and builds the local backend, runs its parser and semantic
highlighting tests, packages and installs the extension into an isolated VS
Code profile, writes the local `clangd.path` setting, and opens a disposable
test project.

For faster incremental development, run only the required stage:

```bash
npm run dev:backend
npm run dev:test-backend
npm run dev:vscode
```

No environment variables are required. If the repositories are not siblings,
pass the backend location after `--`:

```bash
npm run dev:all -- --llvm-project /path/to/llvm-project
```

Use `--no-launch` to prepare the isolated profile without opening VS Code.
Run `npm run dev:all -- --help` for all path and build options.

## Building and running (command line)

```bash
cd vscode-clangd
npm ci
npm run compile  # it runs in watch mode, you can hit ctrl-c.
code --extensionDevelopmentPath=$PWD
```

## Building, running, and debugging (VSCode)

- ```bash
  cd vscode-clangd
  npm ci
  code .
  ```
- with the `vscode-clangd` directory open in VSCode, select
  `Run => Run Without Debugging` or `Run => Start Debugging`

VSCode will recompile the sources for you before launching.
If you change dependencies in `package.json`, run `npm install` and commit the
updated `package-lock.json`.

## Editing and typechecking

`npm run compile` does not actually typecheck the TypeScript code!
(It stripts type annotations and bundles it, using `esbuild`).
You can see diagnostics with `npm run check-ts`.

Using a Typescript-aware editor will show you diagnostics, provide
go-to-definition etc. VSCode works well, or any LSP-capable editor can use
[typescript-language-server](https://github.com/typescript-language-server/typescript-language-server).

# Contributing

Please follow the existing code style when contributing to the extension, we
recommend to run `npm run format` before sending a patch.

# Release

1. In `FlyingsMarmot/llvm-project`, run **Actions → Publish uC++ clangd** with
   a version such as `1.1.0`, the matching `vscode-clangd` commit/tag, and
   `publish-prerelease`. Only collaborators with write access can start it.
2. Test the prerelease on Waterloo Linux, then rerun it with the same version
   and `promote-stable`. Protect the `backend-release` environment with a
   required reviewer and prevent self-approval.
3. Bump the version in `package.json` and `package-lock.json`, update
   `CHANGELOG.md`, and push to `master`. CI publishes the VSIX to GitHub, the
   VS Code Marketplace, and OpenVSX.

Use `build-only` when an unpublished backend artifact is sufficient. The
extension installer only selects stable backend releases.
