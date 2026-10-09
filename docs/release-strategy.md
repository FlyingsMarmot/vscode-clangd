# Release Strategy

The project has two independently releasable components:

1. The VS Code extension, containing the settings, installer, UI, and language
   client.
2. The customized uC++ clangd binary downloaded and launched by the extension.

The Marketplace extension identity is formed from the `publisher` and `name`
fields in `package.json`:

```text
FlyingsMarmot.flyingsmarmot-clangd-ucpp
```

## Recommended release flow

```text
feature branch
    ↓
parser, extension, and sandboxed VS Code tests
    ↓
release-candidate VSIX or Marketplace pre-release
    ↓
manual publisher approval
    ↓
protected Git tag
    ↓
stable Marketplace release
```

Stable publication should require:

- Passing parser and extension regression tests.
- A successfully packaged and smoke-tested VSIX.
- A versioned, platform-specific uC++ clangd release.
- Manual approval from a Marketplace publisher maintainer.
- A protected source tag corresponding to the published version.

For traceability, record an explicit compatibility mapping:

```text
Extension 1.2.0
uC++ clangd 1.2.0-linux-x64
uC++ reference 7.0.0
```

## Release channels

- Use locally distributed VSIX files for development and limited student
  testing.
- Use Marketplace pre-releases for broader release-candidate testing.
- Publish stable releases only after the release candidate passes validation.
- Use separate version series for stable and pre-release builds, such as
  `1.2.x` for stable, `1.3.x` for pre-release, and `1.4.x` for the next stable
  series.

VS Code pre-releases use ordinary `major.minor.patch` versions rather than
SemVer suffixes such as `-beta.1`. A stable and pre-release upload cannot share
the same version.

## Publisher controls

- Keep Marketplace publishing credentials limited to maintainers.
- Store publishing credentials in a protected CI environment.
- Require manual approval before the publish job can access credentials.
- Use the `engines.vscode` manifest field to restrict incompatible releases.
- Prefer short-lived or federated publishing credentials over long-lived
  personal tokens.

Microsoft recommends Entra ID workload identity federation for automated
publishing. Global Azure DevOps personal access tokens are scheduled for
retirement on December 1, 2026.

## Handling a bad release

- Publish a higher patch version containing the fix or rollback.
- Remove an obsolete Marketplace version when appropriate; the current latest
  version cannot be deleted directly.
- Temporarily unpublish the extension if necessary.
- Avoid permanent removal unless the extension is being abandoned, because
  removal is irreversible and reserves the extension name.

## Documentation

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
