import * as assert from 'assert';

import {
  chooseAssetForTest,
  fakeLddCommand,
  fakePlatformForTest,
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
  console.log('installer tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
