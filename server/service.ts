import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import {
  MAX_BYTES, CHUNK_BYTES, beginRpc, chunkRpc, finishRpc, verifyRpc,
  type Job, type Preview, type Snapshot, type DestinationInput, type Receipt,
} from '../shared/transfer';
import { git } from './git';
import { capture, fingerprint, sha256 } from './snapshot';
import { connectDestination } from './connection';

type Paseo = PluginHandlerContext['paseo'];
type Prepared = { preview: Preview; snapshot: Snapshot; data: Buffer; consumed: boolean };
type Running = { job: Job; prepared: Prepared; serverId: string; token?: string; archiving: boolean; app?: boolean };

export async function assertIdle(paseo: Paseo, workspaceId: string, directory: string, archive = false) {
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({ filter: { statuses: ['initializing', 'running'], includeBackground: true, includeInternal: true }, page: { limit: 100, cursor } });
    if (page.entries.some(({ agent }) => agent.workspaceId === workspaceId || agent.cwd === directory || agent.cwd.startsWith(directory + path.sep))) {
      throw new Error('Stop running agents in the source workspace before transferring.');
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  if (archive) {
    const terminals = await paseo.terminals.list({ cwd: directory });
    if (terminals.entries.length) throw new Error('Close the source workspace terminals before archiving.');
  }
}

export class TransferService {
  private prepared = new Map<string, Prepared>();
  private jobs = new Map<string, Running>();
  private locks = new Set<string>();
  private disposed = false;
  private controllers = new Set<Awaited<ReturnType<typeof connectDestination>>>();
  private sweeper = setInterval(() => this.sweep(), 60_000);
  async preview(paseo: Paseo, workspaceId: string): Promise<Preview> {
    this.sweep();
    if (this.prepared.size >= 4) throw new Error('Too many previews. Wait for an older preview to expire.');
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace || workspace.archivingAt) throw new Error('Workspace is unavailable.');
    const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
    await assertIdle(paseo, workspaceId, directory);
    const temporary = await mkdtemp(path.join(tmpdir(), 'paseo-transfert-'));
    try {
      const snapshot = await capture(directory);
      const bundle = path.join(temporary, 'history.bundle');
      await git(directory, ['bundle', 'create', bundle, '--all', 'HEAD']);
      if ((await stat(bundle)).size > MAX_BYTES) throw new Error('Git history exceeds the 128 MiB transfer limit.');
      const data = Buffer.from(JSON.stringify({ snapshot, bundle: (await readFile(bundle)).toString('base64') }));
      if (data.length > MAX_BYTES) throw new Error('Files and Git history exceed the 128 MiB transfer limit.');
      if (fingerprint(await capture(directory)) !== fingerprint(snapshot)) throw new Error('The source changed during preview. Stop file writers and try again.');
      const id = randomUUID();
      const preview: Preview = {
        id, workspaceId, title: workspace.title || workspace.name, directory, branch: snapshot.branch,
        head: snapshot.head, fingerprint: fingerprint(snapshot), bytes: data.length,
        files: snapshot.entries.map(entry => entry.path), ignored: snapshot.ignored,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
      this.prepared.set(id, { preview, snapshot, data, consumed: false });
      return preview;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async start(paseo: Paseo, input: { previewId: string; serverId: string } & DestinationInput) {
    const prepared = this.prepared.get(input.previewId);
    if (!prepared || Date.parse(prepared.preview.expiresAt) < Date.now() || prepared.consumed) throw new Error('Preview expired or already used. Create a new preview.');
    const { workspaceId, directory } = prepared.preview;
    if (this.locks.has(workspaceId)) throw new Error('A transfer is already in progress for this workspace.');
    this.locks.add(workspaceId);
    try {
      await this.assertSource(paseo, prepared);
      prepared.consumed = true;
      const job: Job = { id: randomUUID(), destinationServerId: input.serverId, phase: 'sending', sent: 0, total: prepared.data.length, error: null, receipt: null, sourceArchived: false };
      const running: Running = { job, prepared, serverId: input.serverId, archiving: false };
      this.jobs.set(job.id, running);
      this.prepared.delete(input.previewId);
      // Daemon-side job survives closing the plugin screen; status is available until restart/expiry.
      void this.send(running, input).finally(() => this.locks.delete(workspaceId));
      return { ...job };
    } catch (error) { this.locks.delete(workspaceId); throw error; }
  }
  async exportStart(paseo: Paseo, input: { previewId: string; serverId: string }) {
    const prepared = this.prepared.get(input.previewId);
    if (!prepared || Date.parse(prepared.preview.expiresAt) < Date.now() || prepared.consumed) throw new Error('Preview expired or already used. Create a new preview.');
    const workspaceId = prepared.preview.workspaceId;
    if (this.locks.has(workspaceId)) throw new Error('A transfer is already in progress for this workspace.');
    this.locks.add(workspaceId);
    try {
      await this.assertSource(paseo, prepared);
      const job: Job = { id: randomUUID(), destinationServerId: input.serverId, phase: 'sending', sent: 0, total: prepared.data.length, error: null, receipt: null, sourceArchived: false };
      const digest = sha256(prepared.data);
      prepared.consumed = true;
      this.prepared.delete(input.previewId);
      this.jobs.set(job.id, { job, prepared, serverId: input.serverId, archiving: false, app: true });
      return { job: { ...job }, digest, transferId: prepared.preview.id };
    } catch (error) { this.locks.delete(workspaceId); throw error; }
  }
  exportChunk(id: string, offset: number) {
    const running = this.getJob(id);
    if (!running.app || running.job.phase !== 'sending' || offset >= running.prepared.data.length) throw new Error('Transfer data is unavailable. Create a new preview.');
    const chunk = running.prepared.data.subarray(offset, offset + CHUNK_BYTES);
    running.job.sent = offset + chunk.length;
    return { data: chunk.toString('base64') };
  }
  exportSettle(id: string, receipt?: Receipt, error?: string) {
    const running = this.getJob(id);
    if (!running.app || running.job.phase !== 'sending') throw new Error('Transfer is no longer sending.');
    if (receipt && (receipt.transferId !== running.prepared.preview.id || receipt.digest !== sha256(running.prepared.data))) throw new Error('Destination receipt mismatch.');
    if (!receipt && !error) throw new Error('A receipt or an error is required.');
    running.job.phase = receipt ? 'complete' : 'failed';
    running.job.receipt = receipt ?? null;
    running.job.error = receipt ? null : error!;
    running.prepared.data = Buffer.alloc(0);
    this.locks.delete(running.prepared.preview.workspaceId);
    return this.status(id);
  }
  async exportArchive(paseo: Paseo, id: string, receipt: Receipt) {
    const running = this.getJob(id);
    if (!running.app || running.job.phase !== 'complete' || !running.job.receipt || JSON.stringify(receipt) !== JSON.stringify(running.job.receipt)) throw new Error('Destination receipt mismatch.');
    if (running.job.sourceArchived) return this.status(id);
    const workspaceId = running.prepared.preview.workspaceId;
    if (running.archiving || this.locks.has(workspaceId)) throw new Error('Another operation is in progress.');
    this.locks.add(workspaceId); running.archiving = true;
    try {
      await this.assertSource(paseo, running.prepared, true);
      if (running.prepared.snapshot.ignored.length) throw new Error('Ignored files exist. Copy is allowed, but moving is blocked to avoid data loss.');
      const result = await paseo.workspaces.ref(workspaceId).archive();
      if (result.error || !result.archivedAt) throw new Error(result.error || 'Paseo did not confirm source archiving.');
      running.job.sourceArchived = true;
      return this.status(id);
    } finally { running.archiving = false; this.locks.delete(workspaceId); }
  }
  status(id: string) { return { ...this.getJob(id).job }; }
  async archive(paseo: Paseo, id: string) {
    const running = this.getJob(id);
    if (running.job.sourceArchived) return this.status(id);
    if (running.job.phase !== 'complete' || !running.token) throw new Error('Finish and verify the copy before archiving.');
    if (running.archiving || this.locks.has(running.prepared.preview.workspaceId)) throw new Error('Another operation is in progress.');
    running.archiving = true;
    this.locks.add(running.prepared.preview.workspaceId);
    let connection: Awaited<ReturnType<typeof connectDestination>> | undefined;
    try {
      connection = await connectDestination(running.serverId);
      const receipt = await connection.call(verifyRpc, { token: running.token });
      if (receipt.digest !== running.job.receipt?.digest || receipt.transferId !== running.prepared.preview.id) throw new Error('Destination receipt mismatch.');
      // Check last, directly before the destructive Paseo operation.
      await this.assertSource(paseo, running.prepared, true);
      if (running.prepared.snapshot.ignored.length) throw new Error('Ignored files exist. Copy is allowed, but moving is blocked to avoid data loss.');
      const result = await paseo.workspaces.ref(running.prepared.preview.workspaceId).archive();
      if (result.error || !result.archivedAt) throw new Error(result.error || 'Paseo did not confirm source archiving.');
      running.job.sourceArchived = true;
      return this.status(id);
    } finally {
      running.archiving = false;
      this.locks.delete(running.prepared.preview.workspaceId);
      await connection?.close();
    }
  }
  private async assertSource(paseo: Paseo, prepared: Prepared, archive = false) {
    const workspace = await paseo.workspaces.ref(prepared.preview.workspaceId).refresh();
    if (!workspace || workspace.archivingAt || (workspace.workspaceDirectory ?? workspace.projectRootPath) !== prepared.preview.directory) throw new Error('The source workspace changed or was archived.');
    await assertIdle(paseo, prepared.preview.workspaceId, prepared.preview.directory, archive);
    const current = await capture(prepared.preview.directory);
    if (fingerprint(current) !== prepared.preview.fingerprint) throw new Error('The source changed after preview. Create a new preview. Source archiving is blocked.');
  }
  private async send(running: Running, destination: DestinationInput) {
    let connection: Awaited<ReturnType<typeof connectDestination>> | undefined;
    try {
      connection = await connectDestination(running.serverId);
      this.controllers.add(connection);
      if (this.disposed) throw new Error('Plugin stopped.');
      const { data, preview } = running.prepared;
      const digest = sha256(data);
      const { token } = await connection.call(beginRpc, { ...destination, id: preview.id, bytes: data.length, digest });
      running.token = token;
      for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
        if (this.disposed) throw new Error('Plugin stopped.');
        const chunk = data.subarray(offset, offset + CHUNK_BYTES);
        const response = await connection.call(chunkRpc, { token, offset, data: chunk.toString('base64') });
        if (response.received !== offset + chunk.length) throw new Error('Destination chunk acknowledgment mismatch.');
        running.job.sent = response.received;
      }
      running.job.phase = 'restoring';
      const receipt = await connection.call(finishRpc, { token });
      if (receipt.digest !== digest || receipt.transferId !== preview.id) throw new Error('Destination receipt mismatch.');
      running.job.receipt = receipt;
      running.job.phase = 'complete';
    } catch (error) {
      running.job.phase = 'failed';
      running.job.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (connection) { this.controllers.delete(connection); await connection.close().catch(() => {}); }
      // Keep the lightweight preview for source verification; release the archive bytes.
      running.prepared.data = Buffer.alloc(0);
    }
  }
  private getJob(id: string) {
    const running = this.jobs.get(id);
    if (!running) throw new Error('Transfer not found. It may have expired or the plugin restarted.');
    return running;
  }
  private sweep() {
    const now = Date.now();
    for (const [id, prepared] of this.prepared) if (!prepared.consumed && Date.parse(prepared.preview.expiresAt) < now) this.prepared.delete(id);
    for (const running of this.jobs.values()) if (running.app && running.job.phase === 'sending' && Date.parse(running.prepared.preview.expiresAt) < now) this.exportSettle(running.job.id, undefined, 'Transfer expired. Keep Paseo open during transfers.');
    for (const [id, running] of this.jobs) if (!running.archiving && ['complete', 'failed'].includes(running.job.phase) && Date.parse(running.prepared.preview.expiresAt) + 45 * 60_000 < now) {
      this.jobs.delete(id); this.prepared.delete(running.prepared.preview.id);
    }
  }
  async dispose() {
    this.disposed = true; clearInterval(this.sweeper);
    await Promise.allSettled([...this.controllers].map(connection => connection.close()));
    this.jobs.clear(); this.prepared.clear();
  }
}
