import path from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import * as rpc from './shared/transfer';
import { Receiver, destination } from './server/receiver';
import { TransferService } from './server/service';
import { connectDestination } from './server/connection';

export default function contribute(server: PluginServerContext) {
  const receiver = new Receiver();
  const service = new TransferService();
  const sweep = setInterval(() => receiver.sweep(), 60_000);
  server.handle(rpc.targetsRpc, async (_, { paseo }) => {
    const directory = await paseo.hosts.list();
    return directory.hosts.filter(host => host.enabled && host.status === 'online' && host.serverId && host.serverId !== directory.self.serverId)
      .map(host => ({ serverId: host.serverId!, label: host.label || host.serverId! }));
  });
  server.handle(rpc.previewRpc, ({ workspaceId }, { paseo }) => service.preview(paseo, workspaceId));
  server.handle(rpc.destinationRpc, ({ parent, name }) => destination(parent, name));
  server.handle(rpc.inspectDestinationRpc, async ({ serverId, parent, name }) => {
    const remote = await connectDestination(serverId);
    try { return await remote.call(rpc.destinationRpc, { parent, name }); }
    finally { await remote.close(); }
  });
  server.handle(rpc.beginRpc, input => receiver.begin(input));
  server.handle(rpc.chunkRpc, input => receiver.chunk(input));
  server.handle(rpc.finishRpc, ({ token }, { paseo }) => receiver.finish(token, async directory => {
    // This is already a Git worktree. Register it without running project setup scripts.
    const workspace = await paseo.workspaces.create({ source: { kind: 'directory', path: directory }, title: path.basename(path.dirname(directory)) });
    return workspace.id;
  }));
  server.handle(rpc.verifyRpc, ({ token }) => receiver.verify(token));
  server.handle(rpc.startRpc, (input, { paseo }) => service.start(paseo, input));
  server.handle(rpc.statusRpc, ({ id }) => service.status(id));
  server.handle(rpc.archiveSourceRpc, ({ id }, { paseo }) => service.archive(paseo, id));
  return async () => { clearInterval(sweep); receiver.dispose(); await service.dispose(); };
}
