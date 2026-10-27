import { mkdir, lstat, realpath, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveSchema, MAX_BYTES, CHUNK_BYTES, type Receipt, type Snapshot } from '../shared/transfer';
import { git, nulList } from './git';
import { assertParents, capture, safeRelative, sha256, validateLink } from './snapshot';

export async function destination(parent: string, name: string) {
  if (!path.isAbsolute(parent) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) throw new Error('Choose an absolute parent directory and a simple folder name.');
  const resolved = await realpath(parent);
  const stat = await lstat(resolved);
  if (!stat.isDirectory()) throw new Error('The parent must be an existing directory.');
  if (['/', '/etc', '/usr', '/bin', '/sbin', '/var', '/System', '/Library'].includes(resolved)) throw new Error('Choose a development directory.');
  const root = path.join(resolved, name);
  if (root === homedir()) throw new Error('The destination cannot be your home directory.');
  const existing = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) throw new Error('The destination already exists. Choose a new folder.');
  return { root, repository: path.join(root, 'repository.git'), worktreeParent: path.join(root, 'worktree') };
}
export function contentDigest(snapshot: Snapshot) {
  return sha256(JSON.stringify({ head: snapshot.head, stagedPatch: snapshot.stagedPatch, entries: snapshot.entries }));
}

export async function restore(root: string, bytes: Buffer) {
  if (bytes.length > MAX_BYTES) throw new Error('Transfer exceeds 128 MiB.');
  const archive = archiveSchema.parse(JSON.parse(bytes.toString('utf8')));
  const { snapshot } = archive;
  const seen = new Set<string>();
  const folded = new Set<string>();
  for (const entry of snapshot.entries) {
    safeRelative(entry.path);
    // Refuse case collisions so a Linux checkout also transfers safely to macOS.
    const key = entry.path.normalize('NFC').toLowerCase();
    if (seen.has(entry.path) || folded.has(key)) throw new Error('Duplicate or case-colliding file paths.');
    seen.add(entry.path); folded.add(key);
    if (entry.kind === 'symlink') validateLink(entry.path, Buffer.from(entry.data, 'base64').toString('utf8'));
  }
  for (const entry of snapshot.entries) {
    const parents = entry.path.split('/').slice(0, -1);
    while (parents.length) {
      if (folded.has(parents.join('/').normalize('NFC').toLowerCase())) throw new Error('A file is also used as a directory.');
      parents.pop();
    }
  }
  const repository = path.join(root, 'repository.git');
  const directory = path.join(root, 'worktree');
  const bundlePath = path.join(root, '.history.bundle');
  await writeFile(bundlePath, Buffer.from(archive.bundle, 'base64'), { flag: 'wx', mode: 0o600 });
  await git(root, ['init', '--bare', repository]);
  await git(repository, ['bundle', 'verify', bundlePath]);
  await git(repository, ['-c', 'protocol.file.allow=always', 'fetch', '--no-write-fetch-head', bundlePath, '+refs/*:refs/*']);
  // HEAD may be detached and therefore absent from the advertised refs.
  await git(repository, ['-c', 'protocol.file.allow=always', 'fetch', '--no-write-fetch-head', bundlePath, snapshot.head]);
  await git(repository, ['worktree', 'add', '-b', `transfert/${randomUUID()}`, directory, snapshot.head]);
  // Remove checkout contents, then restore the captured filesystem without following links.
  const baseline = nulList(await git(directory, ['ls-files', '-z']));
  for (const file of baseline) {
    await assertParents(directory, file);
    await rm(path.join(directory, file), { force: true });
  }
  // A file can have replaced a tracked directory. Remove only empty checkout directories.
  const directories = [...new Set(baseline.flatMap(file => {
    const segments = file.split('/'); const result: string[] = [];
    while (segments.length > 1) { segments.pop(); result.push(segments.join('/')); }
    return result;
  }))].sort((a, b) => b.length - a.length);
  const { rmdir } = await import('node:fs/promises');
  for (const dir of directories) await rmdir(path.join(directory, dir)).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  for (const entry of snapshot.entries.filter(e => e.kind === 'file')) {
    await assertParents(directory, entry.path);
    const absolute = path.join(directory, entry.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(entry.data, 'base64'), { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 });
    await chmod(absolute, entry.executable ? 0o755 : 0o644);
  }
  for (const entry of snapshot.entries.filter(e => e.kind === 'symlink')) {
    await assertParents(directory, entry.path);
    const absolute = path.join(directory, entry.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await symlink(Buffer.from(entry.data, 'base64').toString('utf8'), absolute);
  }
  if (snapshot.stagedPatch) await git(directory, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], snapshot.stagedPatch);
  const restored = await capture(directory);
  if (contentDigest(restored) !== contentDigest(snapshot)) throw new Error('Restored files or Git index do not match the source. The source is unchanged.');
  await rm(bundlePath);
  return { directory, repository, contentHash: contentDigest(snapshot) };
}

type Incoming = {
  id: string; root: string; bytes: number; digest: string; received: number; chunks: Buffer[];
  busy: boolean; receipt?: Receipt; contentHash?: string; expiresAt: number;
};
export class Receiver {
  private transfers = new Map<string, Incoming>();
  async begin(input: { id: string; parent: string; name: string; bytes: number; digest: string }) {
    this.sweep();
    if (this.transfers.size >= 8) throw new Error('Too many incoming transfers. Try again later.');
    const target = await destination(input.parent, input.name);
    await mkdir(target.root, { mode: 0o700 }); // Exclusive reservation; never reuse an occupied destination.
    const token = randomUUID();
    this.transfers.set(token, { ...input, root: target.root, received: 0, chunks: [], busy: false, expiresAt: Date.now() + 3_600_000 });
    return { token };
  }
  chunk(input: { token: string; offset: number; data: string }) {
    const transfer = this.get(input.token);
    if (transfer.busy || transfer.receipt) throw new Error('Transfer is already being restored.');
    const data = Buffer.from(input.data, 'base64');
    if (!data.length || data.length > CHUNK_BYTES || input.offset !== transfer.received || transfer.received + data.length > transfer.bytes) throw new Error('Invalid transfer chunk or offset.');
    transfer.chunks.push(data); transfer.received += data.length;
    return { received: transfer.received };
  }
  async finish(token: string, createWorkspace: (directory: string) => Promise<string>) {
    const transfer = this.get(token);
    if (transfer.receipt) return transfer.receipt;
    if (transfer.busy) throw new Error('Transfer is already being restored.');
    transfer.busy = true;
    try {
      if (transfer.received !== transfer.bytes) throw new Error('Incomplete transfer.');
      const data = Buffer.concat(transfer.chunks);
      transfer.chunks = [];
      if (sha256(data) !== transfer.digest) throw new Error('Transfer checksum mismatch.');
      const restored = await restore(transfer.root, data);
      const workspaceId = await createWorkspace(restored.directory);
      transfer.contentHash = restored.contentHash;
      transfer.receipt = { transferId: transfer.id, digest: transfer.digest, workspaceId, directory: restored.directory, repository: restored.repository };
      return transfer.receipt;
    } finally { transfer.busy = false; }
  }
  async verify(token: string) {
    const transfer = this.get(token);
    if (!transfer.receipt || !transfer.contentHash) throw new Error('No verified destination.');
    const snapshot = await capture(transfer.receipt.directory);
    if (contentDigest(snapshot) !== transfer.contentHash) throw new Error('The destination changed. Source archiving is blocked.');
    return transfer.receipt;
  }
  private get(token: string) {
    const transfer = this.transfers.get(token);
    if (!transfer || transfer.expiresAt < Date.now()) throw new Error('Transfer expired. Create a new preview.');
    return transfer;
  }
  sweep() {
    for (const [token, transfer] of this.transfers) if (!transfer.busy && transfer.expiresAt < Date.now()) this.transfers.delete(token);
  }
  dispose() { this.transfers.clear(); }
}
