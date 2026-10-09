// Taken from https://github.com/clangd/node-clangd/blob/master/src/index.ts
// Rationale: Don't want to have to publish a separate npm package for our
// modified VSCode extension

// Automatically install clangd binary releases from GitHub.
//
// We don't bundle them with the package because they're big; we'd have to
// include all OS versions, and download them again with every extension update.
//
// There are several entry points:
//  - installation explicitly requested
//  - checking for updates (manual or automatic)
//  - no usable clangd found, try to recover
// These have different flows, but the same underlying mechanisms.
import * as child_process from 'child_process';
import * as fs from 'fs';
import fetch from 'node-fetch';
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import * as stream from 'stream';
import * as unzipper from 'unzipper';

// Abstracts the editor UI and configuration.
// This allows the core installation flows to be shared across editors, by
// implementing a UI class for each.
export type UI = {
  // Root where we should placed downloaded/installed files.
  readonly storagePath: string;
  // Configured clangd location.
  clangdPath: string;

  // Show a generic message to the user.
  info(s: string): void;
  // Show a generic error message to the user.
  error(s: string): void;
  // Show a message and direct the user to a website.
  showHelp(message: string, url: string): void;

  // Ask the user to reload the plugin.
  promptReload(message: string): void;
  // Ask the user to run installLatest() to upgrade clangd.
  promptUpdate(oldVersion: string, newVersion: string): void;
  // Ask the user to run installLatest() to install missing clangd.
  promptInstall(version: string): void;
  // Ask whether to reuse rather than overwrite an existing clangd installation.
  // Undefined means no choice was made, so we shouldn't do either.
  shouldReuse(path: string): Promise<boolean|undefined>;

  // `work` may take a while to resolve, indicate we're doing something.
  slow<T>(title: string, work: Promise<T>): Promise<T>;
  // `work` will take a while to run and can indicate fractional progress.
  progress<T>(
      title: string,
      cancel: AbortController|null,
      work: (progress: (fraction: number) => void) => Promise<T>,
      ): Promise<T>;

  /**
   * Get localization string.
   * @param message - The message to localize. Supports index templating where
   *     strings like `{0}` and `{1}` are
   * replaced by the item at that index in the {@link args} array.
   * @param args - The arguments to be used in the localized string. The index
   *     of the argument is used to
   * match the template placeholder in the localized string.
   * @returns localized string with injected arguments.
   * @example `localize('Hello {0}!', 'World');`
   */
  localize(message: string, ...args: Array<string|number|boolean>): string;
};

type InstallStatus = {
  // Absolute path to clangd, or null if no valid clangd binary is configured.
  clangdPath: string|null;
  // Background tasks that were started, exposed for testing.
  background: Promise<void>;
};

// Main startup workflow: check whether the configured clangd binary us usable.
// If not, offer to install one. If so, check for updates.
export async function prepare(
    ui: UI,
    checkUpdate: boolean,
    ): Promise<InstallStatus> {
  let clangdPath: string|null = ui.clangdPath;
  if (path.isAbsolute(clangdPath)) {
    try {
      await fs.promises.access(clangdPath);
    } catch (e) {
      console.error('fs.access() failed: ', e);
      clangdPath = null;
    }
  } else {
    clangdPath = await findExecutable(clangdPath);
  }
  if (clangdPath !== null && !await supportsUcpp(clangdPath))
    clangdPath = null;
  if (clangdPath === null) {
    // Workspace settings may still point at stock clangd. Reuse our managed
    // installation without downloading or asking to reinstall on every start.
    const entries = await listFiles(path.join(ui.storagePath, 'install'));
    const filename = currentPlatform() == 'win32' ? 'clangd.exe' : 'clangd';
    for (const entry of entries.reverse()) {
      if (entry.basename == filename && await supportsUcpp(entry.fullPath)) {
        clangdPath = entry.fullPath;
        break;
      }
    }
  }
  if (clangdPath === null) {
    const abort = new AbortController();
    try {
      const release = await Github.latestRelease();
      const asset = await Github.chooseAsset(release);
      ui.info(
          ui.localize('Installing the uC++ language server for this machine.'));
      clangdPath = await Install.install(release, asset, abort, ui);
      if (!await supportsUcpp(clangdPath))
        throw new Error(
            'The downloaded language server does not support uC++.');
      ui.clangdPath = clangdPath;
    } catch (error) {
      clangdPath = null;
      if (!abort.signal.aborted) {
        ui.showHelp(
            ui.localize('Could not set up the uC++ language server: {0}',
                        String(error)),
            installURL,
        );
      }
    }
  }
  return {
    clangdPath,
    background: clangdPath !== null && checkUpdate
                    ? checkUpdates(/*requested=*/ false, ui)
                    : Promise.resolve(),
  };
}

// Check actual parser support rather than relying on a vendor/version string.
export async function supportsUcpp(clangdPath: string): Promise<boolean> {
  const directory =
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clangd-ucpp-'));
  try {
    const source = path.join(directory, 'probe.cpp');
    await fs.promises.writeFile(source,
                                '_Coroutine Probe {};\n_Task TaskProbe {};\n');
    // Isolate the check from compilation databases in parent directories.
    await fs.promises.writeFile(path.join(directory, 'compile_flags.txt'),
                                '-std=c++20\n');
    return await new Promise<boolean>((resolve) => {
      child_process.execFile(
          clangdPath,
          [`--check=${source}`, '--log=error', '--enable-config=false'],
          {timeout: 15000, cwd: directory},
          (error) => resolve(error === null),
      );
    });
  } finally {
    await fs.promises.rm(directory, {recursive: true, force: true});
  }
}

// The user has explicitly asked to install the latest clangd.
// Do so without further prompting, or report an error.
export async function installLatest(ui: UI) {
  const abort = new AbortController();
  try {
    const release = await Github.latestRelease();
    const asset = await Github.chooseAsset(release);
    const clangdPath = await Install.install(release, asset, abort, ui);
    if (!await supportsUcpp(clangdPath))
      throw new Error('The downloaded language server does not support uC++.');
    ui.clangdPath = clangdPath;
    ui.promptReload(
        ui.localize('uC++ clangd {0} is now installed.', release.name));
  } catch (e) {
    if (!abort.signal.aborted) {
      console.error('Failed to install uC++ clangd: ', e);
      const message = ui.localize(
          'Failed to install uC++ clangd language server: {0}\nYou may want to install it manually.',
          e as string,
      );
      ui.showHelp(message, installURL);
    }
  }
}

// We have an apparently-valid clangd (`clangdPath`), check for updates.
export async function checkUpdates(requested: boolean, ui: UI) {
  // Gather all the version information to see if there's an upgrade.
  try {
    var release = await Github.latestRelease();
    await Github.chooseAsset(release); // Ensure a binary for this platform.
    var upgrade = await Version.upgrade(release, ui.clangdPath);
  } catch (e) {
    console.error('Failed to check for clangd update: ', e);
    // We're not sure whether there's an upgrade: stay quiet unless asked.
    if (requested)
      ui.error(
          ui.localize('Failed to check for clangd update: {0}', e as string),
      );
    return;
  }
  console.info(
      'Checking for uC++ clangd update: available=',
      upgrade.new,
      ' installed=',
      upgrade.old,
  );
  // Bail out if the new version is better or comparable.
  if (!upgrade.upgrade) {
    if (requested)
      ui.info(
          ui.localize(
              'uC++ clangd is up-to-date (you have {0}, latest is {1})',
              upgrade.old,
              upgrade.new,
              ),
      );
    return;
  }
  ui.promptUpdate(upgrade.old, upgrade.new);
}

const installURL = 'https://github.com/FlyingsMarmot/llvm-project/releases';
// The GitHub API endpoint for the latest binary clangd release.
let githubReleaseURL =
    'https://api.github.com/repos/FlyingsMarmot/llvm-project/releases/latest';
// Set a fake URL for testing.
export function fakeGitHubReleaseURL(u: string) { githubReleaseURL = u; }
let lddCommand = 'ldd';
export function fakeLddCommand(l: string) { lddCommand = l; }
let currentPlatform = os.platform;
let currentArchitecture = os.arch;
export function fakePlatformForTest(
    platform: NodeJS.Platform|null,
    architecture: string|null,
) {
  currentPlatform = platform === null ? os.platform : () => platform;
  currentArchitecture = architecture === null ? os.arch : () => architecture;
}

async function findExecutable(command: string): Promise<string|null> {
  const platform = currentPlatform();
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  const pathExtensions =
      platform == 'win32'
          ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
          : [''];
  const extensions =
      platform == 'win32' && path.extname(command) ? [''] : pathExtensions;

  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory || '.', command + extension);
      try {
        await fs.promises.access(
            candidate,
            platform == 'win32' ? fs.constants.F_OK : fs.constants.X_OK,
        );
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

type FileEntry = {
  basename: string; fullPath: string;
};

async function listFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(directory: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code == 'ENOENT')
        return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory())
        await visit(fullPath);
      else
        files.push({basename: entry.name, fullPath});
    }
  }
  await visit(root);
  return files;
}

// Bits for talking to github's release API
namespace Github {
export interface Release {
  name: string;
  tag_name: string;
  assets: Array<Asset>;
}
export interface Asset {
  name: string;
  browser_download_url: string;
}

// Fetch the metadata for the latest stable clangd release.
export async function latestRelease(): Promise<Release> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => { timeoutController.abort(); }, 5000);
  try {
    const response = await fetch(githubReleaseURL, {
      signal: timeoutController.signal,
    });
    if (!response.ok) {
      console.error(response.url, response.status, response.statusText);
      throw new Error(`Can't fetch release: ${response.statusText}`);
    }
    return (await response.json()) as Release;
  } finally {
    clearTimeout(timeout);
  }
}

// Determine which release asset should be installed for this machine.
export async function chooseAsset(
    release: Github.Release,
    ): Promise<Github.Asset> {
  const variants: {[key: string]: string} = {
    win32: 'windows',
    linux: 'linux',
    darwin: 'mac',
  };
  const platform = currentPlatform();
  const architecture = currentArchitecture();
  const variant = variants[platform];

  if (variant == 'linux') {
    // Hardcoding this here is sad, but we'd like to offer a nice error message
    // without making the user download the package first.
    const minGlibc = new semver.Range('2.18');
    const oldGlibc = await Version.oldGlibc(minGlibc);
    if (oldGlibc) {
      throw new Error(
          'The clangd release is not compatible with your system ' +
              `(glibc ${oldGlibc.raw} < ${minGlibc.raw}). ` +
              'Try to install it using your package manager instead.',
      );
    }
  }
  const supportedArchitecture =
      architecture == 'x64' || (variant == 'mac' && architecture == 'arm64');
  if (variant && supportedArchitecture) {
    const platformAssets = release.assets.filter((asset) => {
      const name = asset.name.toLowerCase();
      return (name.includes('clangd') &&
              (name.includes(`-${variant}`) || name.includes(`_${variant}`) ||
               name.includes(`.${variant}`)));
    });
    const architectureAliases: {[key: string]: string[]} = {
      x64: ['x86_64', 'x64', 'amd64'],
      arm64: ['arm64', 'aarch64'],
    };
    const allArchitectureAliases = Object.values(architectureAliases).flat();
    const architectureAsset = platformAssets.find(
        (asset) => architectureAliases[architecture].some(
            (alias) => asset.name.toLowerCase().includes(alias),
            ),
    );
    if (architectureAsset)
      return architectureAsset;

    // Platform-only names historically mean x86-64. Do not guess for ARM,
    // because installing an Intel binary there can fail without Rosetta.
    if (architecture == 'x64') {
      const unqualifiedAsset = platformAssets.find(
          (asset) => allArchitectureAliases.every(
              (alias) => !asset.name.toLowerCase().includes(alias),
              ),
      );
      if (unqualifiedAsset)
        return unqualifiedAsset;
    }

    // The historical FlyingsMarmot release predates platform-qualified
    // names. It is the Linux x86-64 build used on Waterloo's student hosts.
    if (platform == 'linux' && architecture == 'x64') {
      const legacyLinuxAsset = release.assets.find(
          (asset) => asset.name.toLowerCase() == 'clangd.zip',
      );
      if (legacyLinuxAsset)
        return legacyLinuxAsset;
    }
  }
  throw new Error(
      `No uC++ clangd ${release.name} binary available for ${platform}/${
          architecture}`,
  );
}
}

export async function chooseAssetForTest(
    release: Github.Release,
    ): Promise<Github.Asset> {
  return Github.chooseAsset(release);
}

// Functions to download and install the releases, and manage the files on disk.
//
// File layout:
//  <ui.storagePath>/
//    install/
//      <version>/
//        clangd_<version>/            (outer director from zip file)
//          bin/clangd
//          lib/clang/...
//    download/
//      clangd-platform-<version>.zip  (deleted after extraction)
namespace Install {
// Download the binary archive `asset` from a github `release` and extract it
// to the extension's global storage location.
// The `abort` controller is signaled if the user cancels the installation.
// Returns the absolute path to the installed clangd executable.
export async function install(
    release: Github.Release,
    asset: Github.Asset,
    abort: AbortController,
    ui: UI,
    ): Promise<string> {
  const dirs = await createDirs(ui);
  const extractRoot = path.join(dirs.install, release.tag_name);
  const entries = await listFiles(extractRoot);
  if (entries.length !== 0) {
    const reuse = await ui.shouldReuse(release.name);
    if (reuse === undefined) {
      // User dismissed prompt, bail out.
      abort.abort();
      throw new Error(`uC++ clangd ${release.name} already installed!`);
    }
    if (reuse) {
      // Find clangd within the existing directory.
      const executable = entries.find(
          (entry) => entry.basename == clangdFilename(),
      );
      if (executable === undefined) {
        throw new Error(`Didn't find ${clangdFilename()} in ${extractRoot}`);
      }
      return executable.fullPath;
    } else {
      // Delete the old version.
      await fs.promises.rm(extractRoot, {recursive: true, force: true});
      // continue with installation.
    }
  }
  const zipFile = path.join(dirs.download, asset.name);
  await download(asset.browser_download_url, zipFile, abort, ui);
  const archive = await unzipper.Open.file(zipFile);
  const executable = archive.files.find(
      (file) => path.basename(file.path) == clangdFilename(),
  );
  if (executable === undefined) {
    throw new Error(`Didn't find ${clangdFilename()} in ${zipFile}`);
  }
  await ui.slow(
      ui.localize('Extracting {0}', asset.name),
      archive.extract({path: extractRoot}),
  );
  const clangdPath = path.join(extractRoot, executable.path);
  await fs.promises.chmod(clangdPath, 0o755);
  await fs.promises.unlink(zipFile);
  return clangdPath;
}

// Create the 'install' and 'download' directories, and return absolute paths.
async function createDirs(ui: UI) {
  const install = path.join(ui.storagePath, 'install');
  const download = path.join(ui.storagePath, 'download');
  for (const dir of [install, download])
    await fs.promises.mkdir(dir, {recursive: true});
  return {install: install, download: download};
}

function clangdFilename() {
  return currentPlatform() == 'win32' ? 'clangd.exe' : 'clangd';
}

// Downloads `url` to a local file `dest` (whose parent should exist).
// A progress dialog is shown, if it is cancelled then `abort` is signaled.
async function download(
    url: string,
    dest: string,
    abort: AbortController,
    ui: UI,
    ): Promise<void> {
  console.info('Downloading ', url, ' to ', dest);
  return ui.progress(
      ui.localize('Downloading {0}', path.basename(dest)),
      abort,
      async (progress) => {
        const response = await fetch(url, {signal: abort.signal});
        if (!response.ok || response.body === null)
          throw new Error(`Can't fetch ${url}: ${response.statusText}`);
        const size = Number(response.headers.get('content-length'));
        let read = 0;
        response.body.on('data', (chunk: Buffer) => {
          read += chunk.length;
          progress(read / size);
        });
        const out = fs.createWriteStream(dest);
        try {
          await stream.promises.pipeline(response.body, out);
        } catch (e) {
          // Clean up the partial file if the download failed.
          fs.unlink(dest, (_) => null); // Don't wait, and ignore error.
          throw e;
        }
      },
  );
}
}

// Functions dealing with clangd versions.
//
// We parse both github release numbers and installed `clangd --version` output
// by treating them as SemVer ranges, and offer an upgrade if the version
// is unambiguously newer.
//
// These functions throw if versions can't be parsed (e.g. installed clangd
// is a vendor-modified version).
namespace Version {
export async function upgrade(release: Github.Release, clangdPath: string) {
  const releasedVer = released(release);
  const installedVer = await installed(clangdPath);
  return {
    old: installedVer.raw,
    new: releasedVer.raw,
    upgrade: rangeGreater(releasedVer, installedVer),
  };
}

const loose: semver.Options = {
  loose: true,
};

// Get the version of an installed clangd binary using `clangd --version`.
async function installed(clangdPath: string): Promise<semver.Range> {
  const output = await run(clangdPath, ['--version']);
  console.info(clangdPath, ' --version output: ', output);
  const prefix = 'clangd version ';
  const pos = output.indexOf(prefix);
  if (pos < 0)
    throw new Error(`Couldn't parse uC++ clangd --version output: ${output}`);
  if (pos > 0) {
    const vendor = output.substring(0, pos).trim();
    if (vendor == 'Apple')
      throw new Error(`Cannot compare vendor's uC++ clangd version: ${output}`);
  }
  // Some vendors add trailing ~patchlevel, ignore this.
  const rawVersion = output.substr(pos + prefix.length).split(/\s|~/, 1)[0];
  return new semver.Range(rawVersion, loose);
}

// Get the version of a github release, by parsing the tag or name.
function released(release: Github.Release): semver.Range {
  // Prefer the tag name, but fall back to the release name.
  return !semver.validRange(release.tag_name, loose) &&
                 semver.validRange(release.name, loose)
             ? new semver.Range(release.name, loose)
             : new semver.Range(release.tag_name, loose);
}

// Detect the (linux) system's glibc version. If older than `min`, return it.
export async function oldGlibc(
    min: semver.Range,
    ): Promise<semver.Range|null> {
  // ldd is distributed with glibc, so ldd --version should be a good proxy.
  const output = await run(lddCommand, ['--version']);
  // The first line is e.g. "ldd (Debian GLIBC 2.29-9) 2.29".
  const line = output.split('\n', 1)[0];
  // Require some confirmation this is [e]glibc, and a plausible
  // version number.
  const match = line.match(/^ldd .*glibc.* (\d+(?:\.\d+)+)[^ ]*$/i);
  if (!match || !semver.validRange(match[1], loose)) {
    console.error(`Can't glibc version from ldd --version output: ${line}`);
    return null;
  }
  const version = new semver.Range(match[1], loose);
  console.info('glibc is', version.raw, 'min is', min.raw);
  return rangeGreater(min, version) ? version : null;
}

// Run a system command and capture any stdout produced.
async function run(command: string, flags: string[]): Promise<string> {
  const child = child_process.spawn(command, flags, {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  for await (const chunk of child.stdout)
    output += chunk;
  return output;
}

function rangeGreater(newVer: semver.Range, oldVer: semver.Range) {
  const minVersion = semver.minVersion(newVer);
  if (minVersion === null) {
    throw new Error(`Couldn't parse version range: ${newVer}`);
  }
  return semver.gtr(minVersion, oldVer);
}
}
