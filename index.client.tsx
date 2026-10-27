import type { PluginClientContext, PluginSidebarItemProps, PluginButtonRegistration } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { registerHost } from './client/federation';
import { TransferScreen } from './client/transfer-screen';

function TransferItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="ArrowRightLeft" active={currentScreen?.screenId === 'transfer'} onPress={() => openScreen({ screenId: 'transfer' })} />;
}
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    registerHost(client),
    client.addScreen({ id: 'transfer', title: 'Transfer', Component: TransferScreen }),
    client.addSidebarHeaderItem({ id: 'transfer', title: 'Transfer', Component: TransferItem }),
    client.addCommandCenterItem({ id: 'transfer-workspace', title: 'Transfer this workspace', icon: 'ArrowRightLeft', context: 'workspace',
      onSelect: ({ workspace, openScreen }) => openScreen({ screenId: 'transfer', params: { workspaceId: workspace.id } }),
    }),
  ];
  const buttons = new Map<string, PluginButtonRegistration>();
  let disposed = false;
  let release: (() => Promise<void>) | undefined;
  function add(workspaceId: string) {
    if (buttons.has(workspaceId) || disposed) return;
    buttons.set(workspaceId, client.addHeaderButton({ id: 'transfer-workspace', workspaceId, button: {
      title: 'Transfer this workspace', label: 'Transfer', icon: 'ArrowRightLeft',
      behavior: { kind: 'action', onPress: () => client.openScreen({ screenId: 'transfer', params: { workspaceId } }) },
    } }));
  }
  void client.paseo.workspaces.list({ subscribe: {} }).then(async ({ subscription }) => {
    if (disposed) { await subscription.release(); return; }
    release = () => subscription.release();
    subscription.subscribe({
      snapshot: ({ entries }) => {
        for (const button of buttons.values()) button.remove();
        buttons.clear();
        for (const workspace of entries) if (workspace.projectKind === 'git') add(workspace.id);
      },
      update: update => {
        if (update.type !== 'workspace_update') return;
        const payload = update.payload;
        if (payload.kind === 'upsert' && payload.workspace.projectKind === 'git') add(payload.workspace.id);
        else if (payload.kind === 'remove') { buttons.get(payload.id)?.remove(); buttons.delete(payload.id); }
      },
      error: error => console.error('[transfert] Workspace subscription failed', error),
    });
  }).catch(error => { if (!disposed) console.error('[transfert] Cannot list workspaces', error); });
  return () => {
    disposed = true;
    for (const cleanup of cleanups) void cleanup();
    for (const button of buttons.values()) button.remove();
    void release?.().catch(error => console.error('[transfert] Cannot release subscription', error));
  };
}
