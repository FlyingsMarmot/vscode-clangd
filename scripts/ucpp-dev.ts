#!/usr/bin/env node

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const packageJson = process.env.npm_package_json;
const extensionRoot =
    packageJson ? path.dirname(path.resolve(packageJson)) : process.cwd();
const nodeMajor = Number(process.versions.node.split('.')[0]);

interface Options {
  command?: string;
  llvmProject: string;
  sandbox: string;
  code?: string;
  jobs: string;
  launch: boolean;
}

if (nodeMajor < 20) {
  console.error(
      `ucpp-dev: Node.js 20 or newer is required; found ${process.version}.`);
  console.error(
      'Install a current Node.js release, or run `nvm use` when using nvm.');
  process.exit(1);
}

function usage(): void {
  console.log(`Usage: npm run dev:<command> -- [options]

Commands:
  dev:backend       Configure and build clang, clangd, and ClangdTests
  dev:test-backend  Run the uC++ parser and semantic-highlighting regressions
  dev:vscode        Package and install the extension, then launch isolated VS Code
  dev:all           Run backend, test, and vscode

Options:
  --llvm-project <path>  Backend checkout (default: ../llvm-project)
  --sandbox <path>       Isolated VS Code data (default: .vscode-test/ucpp-sandbox)
  --code <path>          VS Code launcher (default: auto-detect)
  --jobs <count>         Parallel backend build jobs (default: 2)
  --no-launch            Prepare isolated VS Code without opening a window
  --help                 Show this help
`);
}

function fail(message: string): never {
  console.error(`ucpp-dev: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const result: Options = {
    command: argv[0] === '--help' ? 'help' : argv[0],
    llvmProject: path.resolve(extensionRoot, '..', 'llvm-project'),
    sandbox: path.join(extensionRoot, '.vscode-test', 'ucpp-sandbox'),
    code: undefined,
    jobs: '2',
    launch: true,
  };

  for (let i = 1; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === '--no-launch') {
      result.launch = false;
      continue;
    }
    if (arg === '--help') {
      result.command = 'help';
      continue;
    }

    const value = argv[++i];
    if (value === undefined)
      fail(`${arg} requires a value`);
    if (arg === '--llvm-project')
      result.llvmProject = path.resolve(value);
    else if (arg === '--sandbox')
      result.sandbox = path.resolve(value);
    else if (arg === '--code')
      result.code = value;
    else if (arg === '--jobs')
      result.jobs = value;
    else
      fail(`unknown option: ${arg}`);
  }
  return result;
}

function executable(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(command: string, args: string[], cwd: string): void {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = childProcess.spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error)
    fail(result.error.message);
  if (result.status !== 0)
    fail(`${command} exited with status ${result.status}`);
}

function requireBackend(options: Options): void {
  const source = path.join(options.llvmProject, 'llvm', 'CMakeLists.txt');
  if (!fs.existsSync(source)) {
    fail(`LLVM checkout not found at ${options.llvmProject}. ` +
         'Clone llvm-project beside vscode-clangd or pass ' +
         '--llvm-project /path/to/llvm-project.');
  }
}

function backendPaths(options: Options) {
  const build = path.join(options.llvmProject, 'build', 'ucpp-clangd');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return {
    build,
    clang: path.join(build, 'bin', `clang${suffix}`),
    clangd: path.join(build, 'bin', `clangd${suffix}`),
    tests: path.join(build, 'tools', 'clang', 'tools', 'extra', 'clangd',
                     'unittests', `ClangdTests${suffix}`),
  };
}

function buildBackend(options: Options): void {
  requireBackend(options);
  const paths = backendPaths(options);
  run('cmake',
      [
        '-G',
        'Ninja',
        '-S',
        'llvm',
        '-B',
        paths.build,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DLLVM_ENABLE_ASSERTIONS=ON',
        '-DLLVM_ENABLE_PROJECTS=clang;clang-tools-extra',
        '-DLLVM_INCLUDE_BENCHMARKS=OFF',
        '-DLLVM_INCLUDE_EXAMPLES=OFF',
        '-DLLVM_INCLUDE_TESTS=ON',
        '-DLLVM_PARALLEL_LINK_JOBS=1',
        '-DLLVM_TARGETS_TO_BUILD=Native',
      ],
      options.llvmProject);
  run('cmake',
      [
        '--build',
        paths.build,
        '--target',
        'clang',
        'clangd',
        'ClangdTests',
        '--parallel',
        options.jobs,
      ],
      options.llvmProject);
}

function testBackend(options: Options): void {
  requireBackend(options);
  const paths = backendPaths(options);
  for (const file of [paths.clang, paths.clangd, paths.tests]) {
    if (!fs.existsSync(file))
      fail(`missing ${file}; run npm run dev:backend first`);
  }

  run(paths.clang,
      [
        '-cc1',
        '-std=c++20',
        '-fcxx-exceptions',
        '-Wno-everything',
        '-fsyntax-only',
        '-verify',
        'clang/test/Parser/ucpp-complete.cpp',
      ],
      options.llvmProject);
  run(paths.tests,
      [
        '--gtest_filter=SemanticHighlighting.*',
      ],
      options.llvmProject);
}

function findCode(options: Options): string {
  if (options.code)
    return options.code;
  if (process.platform === 'darwin') {
    const macCode =
        '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    if (fs.existsSync(macCode))
      return macCode;
  }
  return executable('code');
}

function packagePath(): string {
  const manifest = require(path.join(extensionRoot, 'package.json')) as {
    name: string;
    version: string;
  };
  return path.join(extensionRoot, `${manifest.name}-${manifest.version}.vsix`);
}

function prepareVSCode(options: Options): void {
  requireBackend(options);
  const paths = backendPaths(options);
  if (!fs.existsSync(paths.clangd))
    fail(`missing ${paths.clangd}; run npm run dev:backend first`);

  run(executable('npm'), ['run', 'package'], extensionRoot);
  const vsix = packagePath();
  if (!fs.existsSync(vsix))
    fail(`extension package was not created at ${vsix}`);

  const userData = path.join(options.sandbox, 'vscode-data');
  const extensions = path.join(options.sandbox, 'vscode-extensions');
  const project = path.join(options.sandbox, 'project');
  const vscodeDirectory = path.join(project, '.vscode');
  for (const directory of [userData, extensions, vscodeDirectory])
    fs.mkdirSync(directory, {recursive: true});

  fs.writeFileSync(path.join(vscodeDirectory, 'settings.json'),
                   JSON.stringify({
                     'clangd.path': paths.clangd,
                     'clangd.arguments': ['--log=verbose'],
                     'clangd.checkUpdates': false,
                     'clangd.detectExtensionConflicts': false,
                   },
                                  null, 4) +
                       '\n');

  const code = findCode(options);
  const profileArgs = [
    '--user-data-dir',
    userData,
    '--extensions-dir',
    extensions,
  ];
  run(code, [...profileArgs, '--install-extension', vsix, '--force'],
      extensionRoot);

  console.log(`\nIsolated project: ${project}`);
  console.log(`Local clangd: ${paths.clangd}`);
  if (options.launch)
    run(code, [...profileArgs, '--new-window', project], extensionRoot);
}

const options = parseArgs(process.argv.slice(2));
if (!options.command || options.command === 'help') {
  usage();
  process.exit(options.command ? 0 : 1);
}

if (options.command === 'backend')
  buildBackend(options);
else if (options.command === 'test')
  testBackend(options);
else if (options.command === 'vscode')
  prepareVSCode(options);
else if (options.command === 'all') {
  buildBackend(options);
  testBackend(options);
  prepareVSCode(options);
} else {
  fail(`unknown command: ${options.command}`);
}
