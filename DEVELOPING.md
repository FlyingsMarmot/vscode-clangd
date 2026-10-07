# Development

A guide of developing `vscode-clangd` extension.

## Requirements

* VS Code
* Node.js 20 and npm

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
