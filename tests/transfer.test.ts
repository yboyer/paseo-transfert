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

test('existing project receives the exact source commit on a new branch without changing its checkout or refs', async t => {
  const { root, source } = await fixture(t);
  const project = path.join(root, 'mbp-project');
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', source, project]);
  await git(project, ['config', 'user.name', 'Test']);
  await git(project, ['config', 'user.email', 'test@example.com']);
  await writeFile(path.join(project, 'mbp-only.txt'), 'destination-only commit');
  await git(project, ['add', 'mbp-only.txt']);
  await git(project, ['commit', '-m', 'test: diverge destination history']);
  const originalHead = await gitText(project, ['rev-parse', 'HEAD']);
  await writeFile(path.join(project, 'tracked.txt'), 'MBP local work\n');
  await git(source, ['checkout', '-b', 'feature/A']);
  await writeFile(path.join(source, 'new-commit.txt'), 'not pushed to any remote');
  await git(source, ['add', '.']); await git(source, ['commit', '-m', 'test: add source-only commit']);
  await writeFile(path.join(source, 'tracked.txt'), 'staged source work\n');
  await git(source, ['add', 'tracked.txt']);
  await writeFile(path.join(source, 'tracked.txt'), 'unstaged source work\n');
  await writeFile(path.join(source, 'untracked.txt'), 'untracked source work');
  // The same branch already exists and is in use on the destination.
  await git(project, ['branch', 'feature/A']);
  await git(project, ['switch', 'feature/A']);
  const originalRefs = await gitText(project, ['show-ref']);
  const originalStatus = await gitText(project, ['status', '--porcelain']);
  const { snapshot, data } = await archive(source);
  const target = path.join(root, 'received-project'); await mkdir(target);
  const restored = await restore(target, data, project);
  assert.equal(await gitText(restored.directory, ['rev-parse', 'HEAD']), snapshot.head);
  assert.notEqual(snapshot.head, originalHead);
  assert.match(restored.branch, /^transfert\/feature-A-/);
  assert.equal(await gitText(project, ['symbolic-ref', '--short', 'HEAD']), 'feature/A');
  assert.equal(await gitText(project, ['rev-parse', 'HEAD']), originalHead);
  assert.equal(await gitText(project, ['status', '--porcelain']), originalStatus);
  assert.equal(await readFile(path.join(project, 'tracked.txt'), 'utf8'), 'MBP local work\n');
  const preservedRefs = (await gitText(project, ['show-ref'])).split('\n').filter(line => !line.endsWith(`refs/heads/${restored.branch}`)).join('\n');
  assert.equal(preservedRefs, originalRefs);
  assert.equal(contentDigest(await capture(restored.directory)), contentDigest(snapshot));
  assert.equal(await gitText(restored.directory, ['show', ':tracked.txt']), 'staged source work');
  assert.equal(await readFile(path.join(restored.directory, 'tracked.txt'), 'utf8'), 'unstaged source work\n');
  assert.equal(await gitText(restored.directory, ['rev-parse', '--git-common-dir']), path.join(project, '.git'));
});

test('an unrelated destination repository is refused without replacing its branches', async t => {
  const { root, source } = await fixture(t);
  const project = path.join(root, 'unrelated'); await mkdir(project);
  await git(project, ['init', '-b', 'main']);
  await git(project, ['config', 'user.name', 'Test']); await git(project, ['config', 'user.email', 'test@example.com']);
  await writeFile(path.join(project, 'other.txt'), 'different project');
  await git(project, ['add', '.']); await git(project, ['commit', '-m', 'test: create unrelated repository']);
  const refs = await gitText(project, ['show-ref']);
  const { data } = await archive(source);
  const target = path.join(root, 'refused'); await mkdir(target);
  await assert.rejects(restore(target, data, project), /does not share Git history/);
  assert.equal(await gitText(project, ['show-ref']), refs);
  assert.equal(await readFile(path.join(project, 'other.txt'), 'utf8'), 'different project');
});

test('project destinations refuse unknown projects, occupied names and symbolic-link parents', async t => {
  const { root, source } = await fixture(t);
  const { projectDestination } = await import('../server/projects');
  const project = { id: 'project-source', name: 'Source project', directory: source };
  const target = await projectDestination(project, 'copy');
  assert.equal(target.projectId, project.id);
  assert.equal(target.repository, source);
  assert.equal(target.root.startsWith(source + path.sep), false);
  const receiver = new Receiver();
  t.after(async () => receiver.dispose());
  await assert.rejects(receiver.begin({ id: randomUUID(), projectId: 'missing', name: 'copy', bytes: 1, digest: sha256('x') }, project), /unavailable/);
  await receiver.begin({ id: randomUUID(), projectId: project.id, name: 'copy', bytes: 1, digest: sha256('x') }, project);
  await assert.rejects(projectDestination(project, 'copy'), /already exists/);
  await rm(path.join(root, '.paseo-transfers'), { recursive: true });
  await symlink(source, path.join(root, '.paseo-transfers'));
  await assert.rejects(projectDestination(project, 'other'), /Unsafe parent/);
});

test('app connections copy into an existing project and recheck both hosts before archiving', async t => {
  const { root, source } = await fixture(t);
  const rpc = await import('../shared/transfer');
  const { createTransferClient } = await import('../client/connected-transfer');
  const { createFederation } = await import('../client/federation');
  const projectDirectory = path.join(root, 'target-project');
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', source, projectDirectory]);
  await writeFile(path.join(source, 'tracked.txt'), 'staged\n');
  await git(source, ['add', 'tracked.txt']);
  await writeFile(path.join(source, 'tracked.txt'), 'unstaged\n');
  // Force multiple RPC chunks.
  await writeFile(path.join(source, 'large.bin'), Buffer.alloc(CHUNK_BYTES * 2, 42));
  let archived = false;
  const paseo = {
    workspaces: { ref: () => ({ refresh: async () => ({ id: 'source', name: 'source', projectRootPath: source }), archive: async () => { archived = true; return { archivedAt: new Date().toISOString() }; } }) },
    agents: { list: async () => ({ entries: [], pageInfo: {} }) },
    terminals: { list: async () => ({ entries: [] }) },
  } as unknown as Parameters<TransferService['preview']>[0];
  const service = new TransferService();
  const receiver = new Receiver();
  t.after(async () => { receiver.dispose(); await service.dispose(); });
  const registry = createFederation();
  const project = { id: 'target-project', name: 'Target project', directory: projectDirectory };
  const offsets: number[] = [];
  registry.register('source', async (contract, input) => {
    let result: unknown;
    if (contract.name === rpc.exportStartRpc.name) result = await service.exportStart(paseo, rpc.exportStartRpc.input.parse(input));
    else if (contract.name === rpc.exportChunkRpc.name) { const value = rpc.exportChunkRpc.input.parse(input); offsets.push(value.offset); result = service.exportChunk(value.id, value.offset); }
    else if (contract.name === rpc.exportSettleRpc.name) { const value = rpc.exportSettleRpc.input.parse(input); result = service.exportSettle(value.id, value.receipt, value.error); }
    else if (contract.name === rpc.exportArchiveRpc.name) { const value = rpc.exportArchiveRpc.input.parse(input); result = await service.exportArchive(paseo, value.id, value.receipt); }
    else throw new Error(`Unexpected source RPC: ${contract.name}`);
    return contract.output.parse(result);
  });
  let failChunk = true;
  registry.register('target', async (contract, input) => {
    let result: unknown;
    if (contract.name === rpc.beginRpc.name) result = await receiver.begin(rpc.beginRpc.input.parse(input), project);
    else if (contract.name === rpc.chunkRpc.name) {
      if (failChunk) throw new Error('Target disconnected during upload.');
      result = receiver.chunk(rpc.chunkRpc.input.parse(input));
    }
    else if (contract.name === rpc.finishRpc.name) result = await receiver.finish(rpc.finishRpc.input.parse(input).token, async () => 'received');
    else if (contract.name === rpc.verifyRpc.name) result = await receiver.verify(rpc.verifyRpc.input.parse(input).token);
    else throw new Error(`Unexpected target RPC: ${contract.name}`);
    return contract.output.parse(result);
  });
  const client = createTransferClient(registry.rpc);
  const failedPreview = await service.preview(paseo, 'source');
  const failed = await client.start('source', 'target', failedPreview.id, { projectId: project.id, name: 'failed-app-copy' });
  for (let attempts = 0; attempts < 500 && client.status(failed.id).phase === 'sending'; attempts++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(client.status(failed.id).phase, 'failed');
  assert.match(service.status(failed.id).error!, /Target disconnected/);
  assert.throws(() => service.exportChunk(failed.id, 0), /unavailable/);
  await assert.rejects(client.archive(failed.id), /Finish and verify/);
  assert.equal(archived, false);
  failChunk = false;
  offsets.length = 0;
  const preview = await service.preview(paseo, 'source');
  const job = await client.start('source', 'target', preview.id, { projectId: project.id, name: 'app-copy' });
  for (let attempts = 0; attempts < 500 && ['sending', 'restoring'].includes(client.status(job.id).phase); attempts++) await new Promise(resolve => setTimeout(resolve, 10));
  const result = client.status(job.id);
  assert.equal(result.error, null);
  assert.equal(result.phase, 'complete');
  assert.ok(offsets.length > 1);
  assert.equal(result.receipt!.projectId, project.id);
  assert.equal(contentDigest(await capture(result.receipt!.directory)), contentDigest(await capture(source)));
  assert.equal(await gitText(projectDirectory, ['status', '--porcelain']), '');
  const targetFile = path.join(result.receipt!.directory, 'tracked.txt');
  await writeFile(targetFile, 'target changed');
  await assert.rejects(client.archive(job.id));
  assert.equal(archived, false);
  await writeFile(targetFile, 'unstaged\n');
  await writeFile(path.join(source, 'tracked.txt'), 'source changed');
  await assert.rejects(client.archive(job.id), /source changed/i);
  assert.equal(archived, false);
  await writeFile(path.join(source, 'tracked.txt'), 'unstaged\n');
  assert.equal((await client.archive(job.id)).sourceArchived, true);
  assert.equal(archived, true);
});

test('federation releases only its own installation and resolves new capabilities per request', async () => {
  const { createFederation } = await import('../client/federation');
  const { identityRpc } = await import('../shared/transfer');
  const registry = createFederation();
  const call = registry.rpc('host');
  const releaseOld = registry.register('host', async contract => contract.output.parse({ serverId: 'old', protocol: 1 }));
  assert.equal((await call(identityRpc, {})).serverId, 'old');
  const releaseNew = registry.register('host', async contract => contract.output.parse({ serverId: 'new', protocol: 1 }));
  releaseOld();
  assert.equal((await call(identityRpc, {})).serverId, 'new');
  releaseNew();
  assert.throws(() => call(identityRpc, {}), /unavailable/);
});
