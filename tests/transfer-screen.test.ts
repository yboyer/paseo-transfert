import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { PluginScreenProps } from '@getpaseo/plugin/client';

test('transfer screen renders outside a workspace panel and stays scoped when the source changes', async t => {
  const workspaces = [
    { id: 'one', name: 'Workspace One', projectKind: 'git', projectRootPath: '/code/one' },
    { id: 'two', name: 'Workspace Two', projectKind: 'git', projectRootPath: '/code/two' },
  ];
  const refreshed: string[] = [];
  let listCalls = 0;
  const inspected: Record<string, unknown>[] = [];
  const started: Record<string, unknown>[] = [];
  const runtime = globalThis as unknown as {
    IS_REACT_ACT_ENVIRONMENT: boolean;
    transfertScreenTest: { api: unknown; rpc: Record<string, (input: Record<string, unknown>) => Promise<unknown>> };
  };
  runtime.IS_REACT_ACT_ENVIRONMENT = true;
  runtime.transfertScreenTest = {
    api: { workspaces: {
      ref: (id: string) => ({ refresh: async () => { refreshed.push(id); return workspaces.find(workspace => workspace.id === id) ?? null; } }),
      list: async () => { listCalls++; return { entries: workspaces, pageInfo: {} }; },
    } },
    rpc: {
      'transfer.identity': async () => ({ serverId: 'hosted', protocol: 1 }),
      'transfer.projects': async () => [{ id: 'project-one', name: 'MBP Project', directory: '/Users/you/Code/project' }],
      'transfer.destination': async input => {
        inspected.push(input);
        return { root: '/Users/you/Code/.paseo-transfers/copy', repository: '/Users/you/Code/project', worktreeParent: '/Users/you/Code/.paseo-transfers/copy/worktree', projectId: input.projectId, projectName: 'MBP Project' };
      },
      'transfer.preview': async () => ({ id: 'preview', title: 'Workspace One', directory: '/code/one', branch: 'feature/A', head: 'a'.repeat(40), bytes: 100, files: ['code.txt'], ignored: [] }),
      'transfer.start': async input => {
        started.push(input);
        return { id: 'job', destinationServerId: 'mbp', phase: 'complete', sent: 100, total: 100, error: null, sourceArchived: false, receipt: { workspaceId: 'received', directory: '/Users/you/Code/.paseo-transfers/copy/worktree', branch: 'transfert/feature-A-unique' } };
      },
    },
  };
  const temporary = await mkdtemp(path.join(process.cwd(), 'node_modules', '.transfert-screen-test-'));
  t.after(async () => { delete (globalThis as Record<string, unknown>).transfertScreenTest; await rm(temporary, { recursive: true, force: true }); });
  const stateModule = path.resolve('node_modules/@getpaseo/plugin/dist/client/client-state.js');
  const result = await build({
    entryPoints: ['client/transfer-screen.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    plugins: [{ name: 'screen-host', setup(builder) {
      builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: 'paseo', namespace: 'test-host' }));
      builder.onResolve({ filter: /[\/]federation$/ }, () => ({ path: 'federation', namespace: 'test-host' }));
      builder.onResolve({ filter: /[\/]connected-transfer$/ }, () => ({ path: 'connected', namespace: 'test-host' }));
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'native', namespace: 'test-host' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-host' }, ({ path: module }) => ({ resolveDir: process.cwd(), contents: module === 'federation'
        ? `export const federation={subscribe:()=>()=>{},snapshot:()=>1,has:()=>true,rpc:()=> (contract,input)=>globalThis.transfertScreenTest.rpc[contract.name](input)};`
        : module === 'connected'
        ? `export const connectedTransfer={has:()=>false,start:async(source,serverId,previewId,target)=>globalThis.transfertScreenTest.rpc['transfer.start']({serverId,previewId,...target})};`
        : module === 'native'
        ? "export const Pressable='Pressable', ScrollView='ScrollView', Text='Text', TextInput='TextInput', View='View';"
        // Keep the real state hook: this test must fail if the screen calls it without a panel provider.
        : `export { useWorkspace } from ${JSON.stringify(stateModule)};
           const hosts=[{serverId:'hosted',label:'hosted',status:'online'},{serverId:'mbp',label:'MBP',status:'online'}];
           export function useHosts(){return hosts;}
           export function usePaseo() { return globalThis.transfertScreenTest.api; }
           const unused = async () => { throw new Error('Unexpected RPC'); };
           export function useRpc(contract) { return globalThis.transfertScreenTest.rpc[contract.name] || unused; }`,
      }));
    } }],
  });
  const filename = path.join(temporary, 'screen.cjs');
  await writeFile(filename, result.outputFiles[0]!.contents);
  const { TransferScreen } = createRequire(import.meta.url)(filename);
  const props = {
    host: { id: 'hosted', label: 'hosted' }, params: { workspaceId: 'one' },
    layout: { compact: false, platform: 'web' },
    theme: { colors: { surface0: '#111111', surface1: '#222222', surface2: '#333333', border: '#444444', foreground: '#ffffff', foregroundMuted: '#aaaaaa', accent: '#0088ff', accentForeground: '#ffffff', statusSuccess: '#00aa00', statusWarning: '#ffaa00', statusDanger: '#ff0000' } },
  } as PluginScreenProps;
  let screen!: ReactTestRenderer;
  t.after(async () => { await act(async () => screen?.unmount()); });
  await act(async () => { screen = create(createElement(TransferScreen, props)); });
  assert.match(JSON.stringify(screen.toJSON()), /Workspace One/);
  assert.doesNotMatch(JSON.stringify(screen.toJSON()), /Workspace Two/);
  assert.deepEqual(refreshed, ['one']);
  assert.equal(listCalls, 0);
  assert.match(JSON.stringify(screen.toJSON()), /Select a destination host to continue/);
  await act(async () => { screen.root.findByProps({ accessibilityLabel: 'MBP' }).props.onPress(); });
  assert.match(JSON.stringify(screen.toJSON()), /MBP Project/);
  assert.match(JSON.stringify(screen.toJSON()), /Users\/you\/Code\/project/);
  assert.equal(screen.root.findByProps({ accessibilityLabel: 'Show preview' }).props.disabled, true);
  await act(async () => { screen.root.findByProps({ accessibilityLabel: 'Select project MBP Project' }).props.onPress(); });
  assert.equal(screen.root.findByProps({ accessibilityLabel: 'Show preview' }).props.disabled, false);
  await act(async () => { screen.root.findByProps({ accessibilityLabel: 'Show preview' }).props.onPress(); });
  assert.equal(inspected.length, 1);
  assert.equal(inspected[0]!.projectId, 'project-one');
  assert.equal('serverId' in inspected[0]!, false);
  assert.equal('parent' in inspected[0]!, false);
  assert.match(JSON.stringify(screen.toJSON()), /feature\/A/);
  await act(async () => { screen.root.findByProps({ accessibilityLabel: 'Confirm copy' }).props.onPress(); });
  assert.equal(started.length, 1);
  assert.equal(started[0]!.projectId, 'project-one');
  assert.equal(started[0]!.previewId, 'preview');
  assert.equal('parent' in started[0]!, false);
  assert.match(JSON.stringify(screen.toJSON()), /transfert\/feature-A-unique/);

  await act(async () => { screen.update(createElement(TransferScreen, { ...props, params: { workspaceId: 'two' } })); });
  assert.match(JSON.stringify(screen.toJSON()), /Workspace Two/);
  assert.doesNotMatch(JSON.stringify(screen.toJSON()), /Workspace One/);
  assert.deepEqual(refreshed, ['one', 'two']);
  assert.equal(listCalls, 0);

  await act(async () => { screen.update(createElement(TransferScreen, { ...props, params: { workspaceId: 'missing' } })); });
  assert.match(JSON.stringify(screen.toJSON()), /current workspace is unavailable/);
  assert.doesNotMatch(JSON.stringify(screen.toJSON()), /Workspace One|Workspace Two/);
  assert.equal(listCalls, 0);

  await act(async () => { screen.update(createElement(TransferScreen, { ...props, params: {} })); });
  assert.match(JSON.stringify(screen.toJSON()), /Workspace One/);
  assert.match(JSON.stringify(screen.toJSON()), /Workspace Two/);
  assert.equal(listCalls, 1);
});
