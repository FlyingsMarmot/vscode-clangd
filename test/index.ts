import * as assert from 'assert';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {
  chooseAssetForTest,
  fakeGitHubReleaseURL,
  fakeLddCommand,
  fakePlatformForTest,
  prepare,
  supportsUcpp,
  UI,
} from '../src/node-clang-index';

type Release = Parameters<typeof chooseAssetForTest>[0];

const release = (names: string[]): Release => ({
  name: '1.1.0',
  tag_name: '1.1.0',
  assets: names.map((name) => ({
                      name,
                      browser_download_url: `https://example.invalid/${name}`,
                    })),
});

async function rejectsAsset(names: string[], message: RegExp) {
  await assert.rejects(chooseAssetForTest(release(names)), message);
}

async function main() {
  fakeLddCommand('/usr/bin/true');

  fakePlatformForTest('linux', 'x64');
  assert.strictEqual(
      (await chooseAssetForTest(release(['clangd.zip']))).name,
      'clangd.zip',
  );
  assert.strictEqual(
      (await chooseAssetForTest(
           release(['clangd-ucpp-1.1.0-linux-x86_64.zip']),
           ))
          .name,
      'clangd-ucpp-1.1.0-linux-x86_64.zip',
  );

  fakePlatformForTest('darwin', 'arm64');
  assert.strictEqual(
      (await chooseAssetForTest(
           release([
             'clangd-ucpp-1.1.0-mac-x86_64.zip',
             'clangd-ucpp-1.1.0-mac-arm64.zip',
           ]),
           ))
          .name,
      'clangd-ucpp-1.1.0-mac-arm64.zip',
  );
  await rejectsAsset(['clangd.zip'], /darwin\/arm64/);
  await rejectsAsset(['clangd-mac.zip'], /darwin\/arm64/);

  fakePlatformForTest('darwin', 'x64');
  assert.strictEqual(
      (await chooseAssetForTest(
           release(['clangd-ucpp-1.1.0-mac-x86_64.zip']),
           ))
          .name,
      'clangd-ucpp-1.1.0-mac-x86_64.zip',
  );
  assert.strictEqual(
      (await chooseAssetForTest(release(['clangd-mac.zip']))).name,
      'clangd-mac.zip',
  );

  fakePlatformForTest('win32', 'arm64');
  await rejectsAsset(['clangd-windows-arm64.zip'], /win32\/arm64/);

  fakePlatformForTest(null, null);
  await testStartup();
  console.log('installer tests passed');
}

async function testStartup() {
  const directory =
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ucpp-startup-test-'));
  let archive: Buffer|null = null;
  const server = http.createServer((_request, response) => {
    if (_request.url === '/backend.zip') {
      response.end(archive);
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    const metadata = release([]);
    if (archive !== null) {
      metadata.assets.push({
        name: 'clangd-mac-arm64.zip',
        browser_download_url: `http://127.0.0.1:${
            (server.address() as {port: number}).port}/backend.zip`,
      });
    }
    response.end(JSON.stringify(metadata));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as {port: number};
  fakeGitHubReleaseURL(`http://127.0.0.1:${address.port}/release`);
  try {
    const custom = path.join(directory, 'custom-clangd');
    const stock = path.join(directory, 'stock-clangd');
    await fs.promises.writeFile(custom, `#!/usr/bin/env node
const fs = require('fs');
const source = process.argv.find(arg => arg.startsWith('--check=')).slice(8);
if (!fs.readFileSync(source, 'utf8').includes('_Coroutine')) process.exit(1);
process.exit(0);
`);
    await fs.promises.writeFile(stock,
                                '#!/usr/bin/env node\nprocess.exit(1);\n');
    await fs.promises.chmod(custom, 0o755);
    await fs.promises.chmod(stock, 0o755);
    assert.strictEqual(await supportsUcpp(custom), true);
    assert.strictEqual(await supportsUcpp(stock), false);
    assert.strictEqual(await supportsUcpp(path.join(directory, 'missing')),
                       false);
    const errors: string[] = [];
    const ui: UI = {
      storagePath: directory,
      clangdPath: custom,
      info: () => {},
      error: message => errors.push(message),
      showHelp: message => errors.push(message),
      promptReload: () => {},
      promptUpdate: () => {},
      promptInstall: () => {},
      shouldReuse: async () => true,
      slow: (_title, work) => work,
      progress: (_title, _cancel, work) => work(() => {}),
      localize: (message, ...args) => message.replace(
          /\{(\d+)\}/g, (_, index) => String(args[Number(index)])),
    };
    const ready = await prepare(ui, false);
    assert.strictEqual(ready.clangdPath, custom);
    assert.deepStrictEqual(errors, []);
    for (const candidate of [stock, path.join(directory, 'missing')]) {
      ui.clangdPath = candidate;
      const unavailable = await prepare(ui, false);
      assert.strictEqual(unavailable.clangdPath, null);
      await unavailable.background;
      assert.match(errors.pop()!, /No uC\+\+ clangd/);
    }
    const bin = path.join(directory, 'bin');
    await fs.promises.mkdir(bin);
    await fs.promises.copyFile(custom, path.join(bin, 'clangd'));
    child_process.execFileSync('zip', ['-q', 'backend.zip', 'bin/clangd'],
                               {cwd: directory});
    archive = await fs.promises.readFile(path.join(directory, 'backend.zip'));
    fakePlatformForTest('darwin', 'arm64');
    ui.clangdPath = stock;
    const installed = await prepare(ui, false);
    assert.strictEqual(
        installed.clangdPath,
        path.join(directory, 'install', '1.1.0', 'bin', 'clangd'));
    assert.strictEqual(ui.clangdPath, installed.clangdPath);
    assert.strictEqual(await supportsUcpp(installed.clangdPath!), true);
    assert.deepStrictEqual(errors, []);
    archive = null;
    ui.clangdPath = stock;
    const reused = await prepare(ui, false);
    assert.strictEqual(reused.clangdPath, installed.clangdPath);
    assert.deepStrictEqual(errors, []);
  } finally {
    fakePlatformForTest(null, null);
    fakeGitHubReleaseURL(
        'https://api.github.com/repos/FlyingsMarmot/llvm-project/releases/latest');
    await new Promise<void>((resolve, reject) => server.close(
                                error => error ? reject(error) : resolve()));
    await fs.promises.rm(directory, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
