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
  const runtime = globalThis as unknown as {
    IS_REACT_ACT_ENVIRONMENT: boolean;
    transfertScreenTest: { api: unknown; targets: () => Promise<unknown[]> };
  };
  runtime.IS_REACT_ACT_ENVIRONMENT = true;
  runtime.transfertScreenTest = {
    api: { workspaces: {
      ref: (id: string) => ({ refresh: async () => { refreshed.push(id); return workspaces.find(workspace => workspace.id === id) ?? null; } }),
      list: async () => { listCalls++; return { entries: workspaces, pageInfo: {} }; },
    } },
    targets: async () => [],
  };
  const temporary = await mkdtemp(path.join(process.cwd(), 'node_modules', '.transfert-screen-test-'));
  t.after(async () => { delete (globalThis as Record<string, unknown>).transfertScreenTest; await rm(temporary, { recursive: true, force: true }); });
  const stateModule = path.resolve('node_modules/@getpaseo/plugin/dist/client/client-state.js');
  const result = await build({
    entryPoints: ['client/transfer-screen.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    plugins: [{ name: 'screen-host', setup(builder) {
      builder.onResolve({ filter: /^@getpaseo\/plugin\/client$/ }, () => ({ path: 'paseo', namespace: 'test-host' }));
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'native', namespace: 'test-host' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-host' }, ({ path: module }) => ({ resolveDir: process.cwd(), contents: module === 'native'
        ? "export const Pressable='Pressable', ScrollView='ScrollView', Text='Text', TextInput='TextInput', View='View';"
        // Keep the real state hook: this test must fail if the screen calls it without a panel provider.
        : `export { useWorkspace } from ${JSON.stringify(stateModule)};
           export function usePaseo() { return globalThis.transfertScreenTest.api; }
           const unused = async () => { throw new Error('Unexpected RPC'); };
           export function useRpc(contract) { return contract.name === 'transfer.targets' ? globalThis.transfertScreenTest.targets : unused; }`,
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
