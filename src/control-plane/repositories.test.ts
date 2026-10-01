import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { configuredRepositoryPaths, repositoryAvailability, validateRepositoryPath } from './repositories.js';
import { createFixtureStore } from './fixtures.js';
import { delegate } from './mutations.js';

test('Git path validation canonicalizes aliases and rejects missing/non-Git/file/.git/bare paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'registry-test-'));
  try {
    const repo = join(dir, 'repo'); await mkdir(repo); await execa('git', ['init', '-b', 'main', repo]);
    const canonical = await realpath(repo);
    assert.equal(await validateRepositoryPath(`${repo}/../repo/`), canonical);
    await symlink(repo, join(dir, 'alias')); assert.equal(await validateRepositoryPath(join(dir, 'alias')), canonical);
    await mkdir(join(repo, 'nested')); assert.equal(await validateRepositoryPath(join(repo, 'nested')), canonical);
    await writeFile(join(dir, 'file'), 'fixture');
    await execa('git', ['init', '--bare', join(dir, 'bare')]);
    for (const path of [dir, join(dir, 'missing'), join(dir, 'file'), join(repo, '.git'), join(dir, 'bare'), 'relative/repo', `${repo}\0`]) {
      await assert.rejects(validateRepositoryPath(path));
    }
    await symlink(join(repo, '.git'), join(dir, 'metadata-alias'));
    await assert.rejects(validateRepositoryPath(join(dir, 'metadata-alias')), /\.git directory/);
    assert.deepEqual(await repositoryAvailability(canonical), { available: true, unavailableReason: null });
    await rm(join(repo, '.git'), { recursive: true });
    assert.equal((await repositoryAvailability(canonical)).available, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('bootstrap accepts one path or a bounded JSON array without filesystem scanning', () => {
  assert.deepEqual(configuredRepositoryPaths(''), []);
  assert.deepEqual(configuredRepositoryPaths('/repos/my app'), ['/repos/my app']);
  assert.deepEqual(configuredRepositoryPaths('["/repos/one", "/repos/two"]'), ['/repos/one', '/repos/two']);
  assert.throws(() => configuredRepositoryPaths('[invalid'));
  assert.throws(() => configuredRepositoryPaths(JSON.stringify(Array(101).fill('/repos/app'))));
});
test('registered zero-task Git repository enters selector inventory and fake Chief TaskSpec; arbitrary substitution fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'registry-flow-'));
  try {
    await execa('git', ['init', '-b', 'main', dir]);
    const store = createFixtureStore(), registered = await store.registerRepository({ path: dir });
    const project = store.projects().find(p => p.key === registered.key)!;
    assert.equal(project.total, 0); assert.equal(project.registered, true); assert.equal(project.available, true);
    await assert.rejects(store.registerRepository({ path: `${dir}/../${dir.split('/').at(-1)}/` }), /already registered/);
    const result = await delegate({ goal: 'Fixture delegation only', projectKey: registered.key }, store.services);
    assert.equal(result.action, 'create_task');
    if (result.action === 'create_task') assert.equal(store.detail(result.taskId)?.task.repository, await realpath(dir));
    assert.equal(store.projects().find(p => p.key === registered.key)?.total, 1);
    await assert.rejects(delegate({ goal: 'No execution', projectKey: 'f'.repeat(24) }, store.services));
    await assert.rejects(delegate({ goal: 'No execution', repository: { path: dir } }, store.services));
    let lookups = 0, submissions = 0;
    const disappearing = { ...store.services, repository: async (key: string) => ++lookups === 1 ? store.services.repository(key) : null,
      submit: async (...args: Parameters<typeof store.services.submit>) => { submissions++; return store.services.submit(...args); } };
    await assert.rejects(delegate({ goal: 'No execution after disappearance', projectKey: registered.key }, disappearing), /no longer available/);
    assert.equal(submissions, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
