import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = mkdtempSync(join(tmpdir(), 'paseo-coordination-tests-'));
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}
try {
  createRequire(import.meta.url)('node:sqlite');
  const config = JSON.parse(readFileSync(join(root, 'tsconfig.team-coordination.json'), 'utf8'));
  config.compilerOptions.outDir = build;
  config.compilerOptions.rootDir = join(root, 'packages/server/src/server/coordination');
  config.compilerOptions.typeRoots = process.env.PASEO_TEAM_TYPE_ROOTS?.split(delimiter) ?? [join(root, 'node_modules/@types'), join(root, 'packages/server/node_modules/@types')];
  config.files = config.files.map(path => join(root, path));
  const path = join(build, 'tsconfig.json'); writeFileSync(path, JSON.stringify(config));
  writeFileSync(join(build, 'package.json'), '{"type":"module"}');
  const localCompiler = join(root, 'node_modules/typescript/bin/tsc');
  if (existsSync(localCompiler)) run(process.execPath, [localCompiler, '-p', path]);
  else run('tsc', ['-p', path]);
  run(process.execPath, ['--test', 'scripts/team-coordination.test.mjs'], { ...process.env, PASEO_TEAM_TEST_BUILD: build });
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally { rmSync(build, { recursive: true, force: true }); }
