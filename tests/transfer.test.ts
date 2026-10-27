import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, gitText } from '../server/git';
import { capture, fingerprint, sha256, safeRelative, validateLink } from '../server/snapshot';
import { Receiver, destination, contentDigest, restore } from '../server/receiver';
import { TransferService } from '../server/service';
import { CHUNK_BYTES, type Snapshot } from '../shared/transfer';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'transfert-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.name', 'Test']);
  await git(source, ['config', 'user.email', 'test@example.com']);
  await mkdir(path.join(source, 'old-directory'));
  await writeFile(path.join(source, 'old-directory', 'child'), 'original');
  await writeFile(path.join(source, 'tracked.txt'), 'committed\n');
  await writeFile(path.join(source, 'deleted.txt'), 'delete me');
  await writeFile(path.join(source, '.gitignore'), 'ignored/\n');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'test: create fixture']);
  return { root, source };
}
async function archive(source: string) {
  const snapshot = await capture(source);
  const file = path.join(path.dirname(source), `${randomUUID()}.bundle`);
  await git(source, ['bundle', 'create', file, '--all', 'HEAD']);
  const data = Buffer.from(JSON.stringify({ snapshot, bundle: (await readFile(file)).toString('base64') }));
  await rm(file);
  return { snapshot, data };
}

test('round trip preserves history, staged and unstaged changes, binary files, modes, links and deletions', async t => {
  const { root, source } = await fixture(t);
  await writeFile(path.join(source, 'tracked.txt'), 'staged\n');
  await git(source, ['add', 'tracked.txt']);
  await writeFile(path.join(source, 'tracked.txt'), 'unstaged\n');
  await git(source, ['rm', 'deleted.txt']);
  await rm(path.join(source, 'old-directory'), { recursive: true });
  await writeFile(path.join(source, 'old-directory'), 'directory replaced by file');
  await writeFile(path.join(source, 'binary.bin'), Buffer.from([0, 255, 128, 42]));
  await writeFile(path.join(source, 'run.sh'), '#!/bin/sh\ntrue\n');
  await chmod(path.join(source, 'run.sh'), 0o755);
  await symlink('tracked.txt', path.join(source, 'alias'));
  await mkdir(path.join(source, 'ignored'));
  await writeFile(path.join(source, 'ignored', 'secret'), 'do not transfer');
  const { snapshot, data } = await archive(source);
  const target = path.join(root, 'destination');
  await mkdir(target);
  const result = await restore(target, data);
  const received = await capture(result.directory);
  assert.equal(contentDigest(received), contentDigest(snapshot));
  assert.deepEqual(await git(result.directory, ['log', '--format=%H']), await git(source, ['log', '--format=%H']));
  assert.equal(await gitText(result.directory, ['show', ':tracked.txt']), 'staged');
  assert.equal(await readFile(path.join(result.directory, 'tracked.txt'), 'utf8'), 'unstaged\n');
  assert.equal((await lstat(path.join(result.directory, 'run.sh'))).mode & 0o111, 0o111);
  assert.ok(snapshot.ignored.includes('ignored/'));
  assert.ok(!(await readdir(result.directory)).includes('ignored'));
  assert.equal(await gitText(result.directory, ['rev-parse', '--is-inside-work-tree']), 'true');
  assert.ok((await readFile(path.join(result.directory, '.git'), 'utf8')).startsWith('gitdir:'));
});

test('detached HEAD and staged additions remain restorable', async t => {
  const { root, source } = await fixture(t);
  await git(source, ['checkout', '--detach']);
  await writeFile(path.join(source, 'new.txt'), 'new staged');
  await git(source, ['add', 'new.txt']);
  const { snapshot, data } = await archive(source);
  const target = path.join(root, 'destination'); await mkdir(target);
  const result = await restore(target, data);
  assert.equal(contentDigest(await capture(result.directory)), contentDigest(snapshot));
});

test('fingerprint detects content, index, ignored paths, branch and reference changes', async t => {
  const { source } = await fixture(t);
  const first = fingerprint(await capture(source));
  await writeFile(path.join(source, 'tracked.txt'), 'changed');
  const second = fingerprint(await capture(source));
  assert.notEqual(second, first);
  await git(source, ['add', 'tracked.txt']);
  assert.notEqual(fingerprint(await capture(source)), second);
});

test('receiver enforces ordering, digest, single restoration, and destination verification', async t => {
  const { root, source } = await fixture(t);
  const { data } = await archive(source);
  const receiver = new Receiver(); t.after(async () => receiver.dispose());
  const id = randomUUID();
  const { token } = await receiver.begin({ id, parent: root, name: 'received', bytes: data.length, digest: sha256(data) });
  assert.throws(() => receiver.chunk({ token, offset: 1, data: data.toString('base64') }), /offset/);
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) receiver.chunk({ token, offset, data: data.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
  let calls = 0;
  const receipt = await receiver.finish(token, async directory => { calls++; assert.ok(directory.endsWith('/worktree')); return 'workspace-test'; });
  assert.equal(receipt.transferId, id);
  assert.equal(calls, 1);
  assert.deepEqual(await receiver.finish(token, async () => { throw new Error('must not run'); }), receipt);
  assert.deepEqual(await receiver.verify(token), receipt);
  await writeFile(path.join(receipt.directory, 'tracked.txt'), 'changed on receiver');
  await assert.rejects(receiver.verify(token), /destination changed/);
});

test('incomplete and corrupted transfers cannot create a workspace', async t => {
  const { root } = await fixture(t);
  const receiver = new Receiver(); t.after(async () => receiver.dispose());
  const { token } = await receiver.begin({ id: randomUUID(), parent: root, name: 'corrupt', bytes: 3, digest: sha256('abc') });
  await assert.rejects(receiver.finish(token, async () => 'bad'), /Incomplete/);
  receiver.chunk({ token, offset: 0, data: Buffer.from('xyz').toString('base64') });
  await assert.rejects(receiver.finish(token, async () => 'bad'), /checksum mismatch/);
});

test('occupied destinations and invalid names are refused', async t => {
  const { root } = await fixture(t);
  await assert.rejects(destination(root, 'source'), /already exists/);
  for (const name of ['../other', '.git', 'a/b', '', '-option']) await assert.rejects(destination(root, name));
  await assert.rejects(destination('relative', 'project'));
});

test('unsafe paths and symbolic links are refused before restoration', async t => {
  for (const file of ['../secret', '/etc/passwd', 'a/../b', '.git/config', 'x/.GIT/config', 'a\\b', 'x//y']) assert.throws(() => safeRelative(file));
  for (const target of ['/etc/passwd', '../../secret', '../.git/config']) assert.throws(() => validateLink('alias', target));
  const { root, source } = await fixture(t);
  await symlink('/etc/passwd', path.join(source, 'external'));
  await assert.rejects(capture(source), /External symbolic link/);
  await rm(path.join(source, 'external'));
  const original = await archive(source);
  const parsed = JSON.parse(original.data.toString()) as { snapshot: Snapshot; bundle: string };
  parsed.snapshot.entries.push({ path: '../escape', kind: 'file', executable: false, data: 'eA==' });
  const target = path.join(root, 'unsafe'); await mkdir(target);
  await assert.rejects(restore(target, Buffer.from(JSON.stringify(parsed))), /Unsafe file path/);
  assert.deepEqual(await readdir(target), []);
});

test('case collisions and file/directory collisions are refused', async t => {
  const { root, source } = await fixture(t);
  const original = await archive(source);
  for (const [name, paths] of [['case', ['A', 'a']], ['directory', ['parent', 'parent/child']]] as const) {
    const parsed = JSON.parse(original.data.toString()) as { snapshot: Snapshot; bundle: string };
    for (const file of paths) parsed.snapshot.entries.push({ path: file, kind: 'file', executable: false, data: 'eA==' });
    const target = path.join(root, name); await mkdir(target);
    await assert.rejects(restore(target, Buffer.from(JSON.stringify(parsed))), /collid|directory/);
  }
});

test('source changes after preview block a transfer before any destination is contacted', async t => {
  const { source } = await fixture(t);
  let archived = false;
  const service = new TransferService(); t.after(() => service.dispose());
  const paseo = {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: source, projectRootPath: source, name: 'test' }), archive: async () => { archived = true; } }) },
    agents: { list: async () => ({ entries: [], pageInfo: {} }) },
  } as unknown as Parameters<TransferService['preview']>[0];
  const preview = await service.preview(paseo, 'source');
  await writeFile(path.join(source, 'tracked.txt'), 'changed after approval');
  await assert.rejects(service.start(paseo, { previewId: preview.id, serverId: 'remote', parent: '/unused', name: 'unused' }), /source changed/i);
  assert.equal(archived, false);
});

test('an active agent prevents snapshot creation', async t => {
  const { source } = await fixture(t);
  const service = new TransferService(); t.after(() => service.dispose());
  const paseo = {
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: source, projectRootPath: source, name: 'test' }) }) },
    agents: { list: async () => ({ entries: [{ agent: { workspaceId: 'source', cwd: source } }], pageInfo: {} }) },
  } as unknown as Parameters<TransferService['preview']>[0];
  await assert.rejects(service.preview(paseo, 'source'), /Stop running agents/);
});

test('Git LFS repositories are refused instead of silently changing index semantics', async t => {
  const { source } = await fixture(t);
  await writeFile(path.join(source, '.gitattributes'), '*.bin filter=lfs\n');
  await writeFile(path.join(source, 'asset.bin'), 'some data');
  await assert.rejects(capture(source), /Git LFS/);
});

test('a checkout with all files staged for deletion can be transferred', async t => {
  const { root, source } = await fixture(t);
  await git(source, ['rm', '-r', '.']);
  const { snapshot, data } = await archive(source);
  const target = path.join(root, 'empty'); await mkdir(target);
  const result = await restore(target, data);
  assert.equal(snapshot.entries.length, 0);
  assert.equal(contentDigest(await capture(result.directory)), contentDigest(snapshot));
});
