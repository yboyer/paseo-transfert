import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHostClient } from '@getpaseo/client/node';
import { createPaseoApi } from '@getpaseo/client';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { z } from 'zod';
import * as rpc from '../shared/transfer';
import { git, gitText } from '../server/git';

const exec = promisify(execFile);
async function port() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('installed plugin copies between two Paseo daemons and safely archives a managed source worktree', { timeout: 180_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'paseo-transfert-live-'));
  const homes = [path.join(root, 'a'), path.join(root, 'b')];
  const password = randomUUID();
  const env = { ...process.env, PASEO_PASSWORD: password };
  const ports = [await port(), await port()];
  t.after(async () => {
    for (const home of homes) await exec('paseo', ['daemon', 'stop', '--home', home, '--json'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  for (const [index, home] of homes.entries()) {
    await mkdir(home);
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ daemon: { listen: `127.0.0.1:${ports[index]}` }, pluginsEnabled: true }));
    await exec('paseo', ['daemon', 'start', '--home', home, '--timeout', '30', '--json'], { env });
    await exec('paseo', ['--home', home, 'plugin', 'install', process.cwd(), '--json'], { env, maxBuffer: 1024 * 1024 });
  }
  const clients: ReturnType<typeof createHostClient>[] = [];
  for (const [index, home] of homes.entries()) {
    const client = createHostClient(`127.0.0.1:${ports[index]}`, {
      clientId: randomUUID(), clientType: 'cli', appVersion: '0.13.0',
      localCredential: async () => (await readFile(path.join(home, 'local-credential'), 'utf8')).trim(),
      reconnect: { enabled: false }, connectTimeoutMs: 10_000,
    });
    await client.connect(); clients.push(client);
  }
  t.after(async () => { for (const client of clients) await client.close(); });
  const sourceClient = clients[0]!;
  const destinationClient = clients[1]!;
  const destinationApi = createPaseoApi(destinationClient);
  t.after(() => destinationApi.dispose());
  const api = createPaseoApi(sourceClient);
  t.after(() => api.dispose());
  async function call<I extends z.ZodType, O extends z.ZodType>(contract: PluginRpcContract<I, O>, input: z.input<I>) {
    return contract.output.parse(await sourceClient.invokePluginRpc(rpc.PLUGIN_ID, contract.name, contract.input.parse(input)));
  }
  await sourceClient.addHost({ connection: `ws://127.0.0.1:${ports[1]}/ws?password=${encodeURIComponent(password)}`, label: 'destination-test' });
  let targets: z.output<typeof rpc.targetsRpc.output> = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    targets = await call(rpc.targetsRpc, {});
    if (targets.length) break;
    await pause(250);
  }
  assert.equal(targets.length, 1, 'destination becomes available');
  const serverId = targets[0]!.serverId;
  const repository = path.join(root, 'project'); await mkdir(repository);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Test']);
  await git(repository, ['config', 'user.email', 'test@example.com']);
  await writeFile(path.join(repository, 'code.txt'), 'committed\n');
  await writeFile(path.join(repository, '.gitignore'), 'ignored/\n');
  await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'test: create fixture']);
  const source = await api.workspaces.create({ source: { kind: 'worktree', cwd: repository, action: 'branch-off', refName: 'main', branchName: 'feat/test-transfer' } });
  const sourceDirectory = source.directory!;
  assert.ok(sourceDirectory);
  const destinationRepository = path.join(root, 'mbp-project');
  await git(root, ['-c', 'protocol.file.allow=always', 'clone', repository, destinationRepository]);
  await git(destinationRepository, ['switch', '-c', 'feat/test-transfer']);
  await writeFile(path.join(destinationRepository, 'code.txt'), 'MBP work stays untouched\n');
  const existingWorkspace = await destinationApi.workspaces.open(destinationRepository);
  const existingProject = (await call(rpc.destinationProjectsRpc, { serverId })).find(project => project.directory === destinationRepository);
  assert.ok(existingProject, 'existing destination project is listed');
  const destinationHead = await gitText(destinationRepository, ['rev-parse', 'HEAD']);
  await writeFile(path.join(sourceDirectory, 'source-only.txt'), 'source commit not present on the MBP');
  await git(sourceDirectory, ['add', 'source-only.txt']);
  await git(sourceDirectory, ['commit', '-m', 'test: add source-only commit']);

  await writeFile(path.join(sourceDirectory, 'code.txt'), 'staged\n');
  await git(sourceDirectory, ['add', 'code.txt']);
  await writeFile(path.join(sourceDirectory, 'code.txt'), 'unstaged\n');
  await writeFile(path.join(sourceDirectory, 'untracked.txt'), 'untracked\n');
  await writeFile(path.join(sourceDirectory, 'paseo.json'), JSON.stringify({ worktree: { setup: 'touch setup-must-not-run' } }));
  const preview = await call(rpc.previewRpc, { workspaceId: source.id });
  const destination = await call(rpc.inspectDestinationRpc, { serverId, parent: root, name: 'copy' });
  assert.equal(destination.root, path.join(root, 'copy'));
  const started = await call(rpc.startRpc, { previewId: preview.id, serverId, parent: root, name: 'copy' });
  let job = started;
  for (let attempt = 0; attempt < 160; attempt++) {
    job = await call(rpc.statusRpc, { id: started.id });
    if (job.phase === 'complete' || job.phase === 'failed') break;
    await pause(250);
  }
  assert.equal(job.phase, 'complete', job.error || 'transfer finishes');
  assert.ok(job.receipt);
  await assert.rejects(access(path.join(job.receipt.directory, 'setup-must-not-run')), /ENOENT/);
  assert.equal(await readFile(path.join(job.receipt.directory, 'code.txt'), 'utf8'), 'unstaged\n');
  assert.ok(await destinationApi.workspaces.ref(job.receipt.workspaceId).refresh());
  const projectTarget = await call(rpc.inspectDestinationRpc, { serverId, projectId: existingProject.id, name: 'project-transfer' });
  assert.equal(projectTarget.projectId, existingProject.id);
  assert.equal(projectTarget.repository, destinationRepository);
  const projectPreview = await call(rpc.previewRpc, { workspaceId: source.id });
  const projectStarted = await call(rpc.startRpc, { previewId: projectPreview.id, serverId, projectId: existingProject.id, name: 'project-transfer' });
  let projectJob = projectStarted;
  for (let attempt = 0; attempt < 160; attempt++) {
    projectJob = await call(rpc.statusRpc, { id: projectStarted.id });
    if (['complete', 'failed'].includes(projectJob.phase)) break;
    await pause(250);
  }
  assert.equal(projectJob.phase, 'complete', projectJob.error || 'transfer into existing project finishes');
  assert.ok(projectJob.receipt);
  assert.equal(projectJob.receipt.projectId, existingProject.id);
  assert.match(projectJob.receipt.branch!, /^transfert\/feat-test-transfer-/);
  const projectWorkspace = await destinationApi.workspaces.ref(projectJob.receipt.workspaceId).refresh();
  assert.equal(projectWorkspace?.projectId, existingProject.id);
  assert.notEqual(projectJob.receipt.workspaceId, existingWorkspace.id);
  assert.equal(await gitText(projectJob.receipt.directory, ['rev-parse', 'HEAD']), preview.head);
  assert.equal(await gitText(projectJob.receipt.directory, ['rev-parse', '--git-common-dir']), path.join(destinationRepository, '.git'));
  assert.equal(await readFile(path.join(projectJob.receipt.directory, 'code.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await gitText(projectJob.receipt.directory, ['show', ':code.txt']), 'staged');
  assert.equal(await gitText(destinationRepository, ['rev-parse', 'HEAD']), destinationHead);
  assert.equal(await readFile(path.join(destinationRepository, 'code.txt'), 'utf8'), 'MBP work stays untouched\n');
  await assert.rejects(access(path.join(projectJob.receipt.directory, 'setup-must-not-run')), /ENOENT/);

  // App-mediated transport: use independent connections rather than the daemon route.
  const { createFederation } = await import('../client/federation');
  const { createTransferClient } = await import('../client/connected-transfer');
  const registry = createFederation();
  const sourceId = (await call(rpc.identityRpc, {})).serverId;
  for (const [id, client] of [[sourceId, sourceClient], [serverId, destinationClient]] as const) {
    registry.register(id, async (contract, input) => contract.output.parse(await client.invokePluginRpc(rpc.PLUGIN_ID, contract.name, contract.input.parse(input))));
  }
  const app = createTransferClient(registry.rpc);
  const appPreview = await call(rpc.previewRpc, { workspaceId: source.id });
  const appStart = await app.start(sourceId, serverId, appPreview.id, { projectId: existingProject.id, name: 'app-project-transfer' });
  for (let attempt = 0; attempt < 160 && ['sending', 'restoring'].includes(app.status(appStart.id).phase); attempt++) await pause(250);
  const appJob = app.status(appStart.id);
  assert.equal(appJob.phase, 'complete', appJob.error || 'app-mediated transfer finishes');
  const appWorkspace = await destinationApi.workspaces.ref(appJob.receipt!.workspaceId).refresh();
  assert.equal(appWorkspace?.projectId, existingProject.id);
  assert.equal(await readFile(path.join(appJob.receipt!.directory, 'code.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await gitText(appJob.receipt!.directory, ['show', ':code.txt']), 'staged');
  assert.equal(await readFile(path.join(destinationRepository, 'code.txt'), 'utf8'), 'MBP work stays untouched\n');

  await writeFile(path.join(job.receipt.directory, 'code.txt'), 'changed on destination');
  await assert.rejects(call(rpc.archiveSourceRpc, { id: job.id, confirm: true }), /destination changed/);
  await access(sourceDirectory);
  await writeFile(path.join(job.receipt.directory, 'code.txt'), 'unstaged\n');
  await writeFile(path.join(sourceDirectory, 'code.txt'), 'changed on source');
  await assert.rejects(call(rpc.archiveSourceRpc, { id: job.id, confirm: true }), /source changed/i);
  await access(sourceDirectory);
  await writeFile(path.join(sourceDirectory, 'code.txt'), 'unstaged\n');
  // Ignored data must survive a refused move, even when the copy itself is valid.
  await mkdir(path.join(sourceDirectory, 'ignored'));
  await writeFile(path.join(sourceDirectory, 'ignored', 'secret'), 'keep source data');
  const ignoredPreview = await call(rpc.previewRpc, { workspaceId: source.id });
  const ignoredStart = await call(rpc.startRpc, { previewId: ignoredPreview.id, serverId, parent: root, name: 'copy-with-ignored' });
  let ignoredJob = ignoredStart;
  for (let attempt = 0; attempt < 160; attempt++) {
    ignoredJob = await call(rpc.statusRpc, { id: ignoredJob.id });
    if (['complete', 'failed'].includes(ignoredJob.phase)) break;
    await pause(250);
  }
  assert.equal(ignoredJob.phase, 'complete', ignoredJob.error || 'copy with ignored files finishes');
  await assert.rejects(call(rpc.archiveSourceRpc, { id: ignoredJob.id, confirm: true }), /Ignored files/);
  assert.equal(await readFile(path.join(sourceDirectory, 'ignored', 'secret'), 'utf8'), 'keep source data');
  await rm(path.join(sourceDirectory, 'ignored'), { recursive: true });
  const terminal = await source.terminals.create({ name: 'test archive guard' });
  await assert.rejects(call(rpc.archiveSourceRpc, { id: job.id, confirm: true }), /Close.*terminals/);
  await terminal.kill();
  const result = await call(rpc.archiveSourceRpc, { id: job.id, confirm: true });
  assert.equal(result.sourceArchived, true);
  await assert.rejects(access(sourceDirectory), /ENOENT/);
  await access(job.receipt.directory);
  console.log('Live transfer, destination workspace, integrity checks and managed-source deletion verified.');
});
