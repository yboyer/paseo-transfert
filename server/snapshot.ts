import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readFile, readlink, realpath, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MAX_BYTES, MAX_FILES, type Snapshot } from '../shared/transfer';
import { git, gitText, nulList } from './git';

export function sha256(data: string | Buffer) { return createHash('sha256').update(data).digest('hex'); }
export function fingerprint(snapshot: Snapshot) { return sha256(JSON.stringify(snapshot)); }
export function safeRelative(value: string) {
  if (!value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) {
    throw new Error(`Unsafe file path: ${value}`);
  }
}
export async function assertParents(root: string, relative: string) {
  safeRelative(relative);
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe parent directory: ${relative}`);
  }
}
export function validateLink(file: string, target: string) {
  if (!target || target.includes('\\') || target.includes('\0') || path.posix.isAbsolute(target)) throw new Error(`External symbolic link: ${file}`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
  if (resolved === '..' || resolved.startsWith('../') || resolved.split('/').some(p => p.toLowerCase() === '.git')) throw new Error(`External symbolic link: ${file}`);
}
export async function sourceDirectory(directory: string) {
  const root = await realpath(directory);
  if (root === path.parse(root).root || root === await realpath(homedir())) throw new Error('Select a project directory, not a home or system directory.');
  const top = await gitText(root, ['rev-parse', '--show-toplevel']);
  if (await realpath(top) !== root) throw new Error('The workspace must point to the root of a Git checkout.');
  return root;
}
export async function capture(directory: string): Promise<Snapshot> {
  const root = await sourceDirectory(directory);
  const index = nulList(await git(root, ['ls-files', '--stage', '-z']));
  if (index.some(line => line.startsWith('160000 '))) throw new Error('Submodules are not supported.');
  if (index.some(line => !/^[0-7]+ [a-f0-9]+ 0\t/.test(line))) throw new Error('Resolve Git conflicts before transferring.');
  const head = await gitText(root, ['rev-parse', 'HEAD']);
  const branch = await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const refs = await gitText(root, ['show-ref']);
  const stagedPatch = (await git(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).toString();
  const paths = [...new Set(nulList(await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])))].sort();
  const ignored = nulList(await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).sort();
  const filters = paths.length ? nulList(await git(root, ['check-attr', '-z', '--stdin', 'filter'], Buffer.from(paths.join('\0') + '\0'))) : [];
  if (filters.some((value, index) => index % 3 === 2 && value === 'lfs')) throw new Error('Git LFS files are not supported.');
  if (paths.length > MAX_FILES || ignored.length > MAX_FILES) throw new Error('Too many files (maximum 20,000).');
  const entries: Snapshot['entries'] = [];
  let bytes = Buffer.byteLength(stagedPatch);
  for (const file of paths) {
    safeRelative(file);
    const absolute = path.join(root, file);
    const stat = await lstat(absolute).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; });
    if (!stat) continue;
    await assertParents(root, file);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported file type: ${file}`);
    if (bytes + stat.size > MAX_BYTES) throw new Error('Files exceed the 128 MiB transfer limit.');
    let data: Buffer;
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      validateLink(file, target);
      data = Buffer.from(target);
    } else {
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { data = await handle.readFile(); } finally { await handle.close(); }
    }
    bytes += data.length;
    if (bytes > MAX_BYTES) throw new Error('Files exceed the 128 MiB transfer limit.');
    entries.push({ path: file, kind: stat.isSymbolicLink() ? 'symlink' : 'file', executable: !!(stat.mode & 0o111), data: data.toString('base64') });
  }
  return { version: 1, head, branch, refs, stagedPatch, entries, ignored };
}
