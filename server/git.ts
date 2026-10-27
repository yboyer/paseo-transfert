import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';

// Never use a shell. Disable hooks and network protocols when reading received Git data.
export function git(cwd: string, args: string[], input?: string | Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 180 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (errors.reduce((n, b) => n + b.length, 0) < 8192) errors.push(chunk); });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(overflow ? 'Git output exceeds the transfer limit.' : Buffer.concat(errors).toString().trim() || `Git failed (${code}).`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
export async function gitText(cwd: string, args: string[]) { return (await git(cwd, args)).toString().trim(); }
export function nulList(buffer: Buffer) {
  if (!isUtf8(buffer)) throw new Error('Git paths must use valid UTF-8.');
  return buffer.toString('utf8').split('\0').filter(Boolean);
}
