import path from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import * as rpc from './shared/transfer';
import { Receiver, destination } from './server/receiver';
import { TransferService } from './server/service';
import { connectDestination } from './server/connection';
import { listProjects, findProject, projectDestination } from './server/projects';

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
  server.handle(rpc.projectsRpc, (_, { paseo }) => listProjects(paseo));
  server.handle(rpc.destinationProjectsRpc, async ({ serverId }) => {
    const remote = await connectDestination(serverId);
    try { return await remote.call(rpc.projectsRpc, {}); }
    catch (error) { throw new Error(`Cannot load destination projects. Update Transfer on both hosts. ${error instanceof Error ? error.message : String(error)}`); }
    finally { await remote.close(); }
  });
  server.handle(rpc.destinationRpc, async (input, { paseo }) => 'projectId' in input
    ? projectDestination(await findProject(paseo, input.projectId), input.name)
    : destination(input.parent, input.name));
  server.handle(rpc.inspectDestinationRpc, async ({ serverId, ...input }) => {
    const remote = await connectDestination(serverId);
    try { return await remote.call(rpc.destinationRpc, input); }
    finally { await remote.close(); }
  });
  server.handle(rpc.beginRpc, async (input, { paseo }) => receiver.begin(input, 'projectId' in input ? await findProject(paseo, input.projectId) : undefined));
  server.handle(rpc.chunkRpc, input => receiver.chunk(input));
  server.handle(rpc.finishRpc, ({ token }, { paseo }) => receiver.finish(token, async (directory, projectId) => {
    // This is already a Git worktree. Register it without running project setup scripts.
    const workspace = await paseo.workspaces.create({ source: { kind: 'directory', path: directory, ...(projectId ? { projectId } : {}) }, title: path.basename(path.dirname(directory)) });
    return workspace.id;
  }));
  server.handle(rpc.verifyRpc, ({ token }) => receiver.verify(token));
  server.handle(rpc.startRpc, (input, { paseo }) => service.start(paseo, input));
  server.handle(rpc.statusRpc, ({ id }) => service.status(id));
  server.handle(rpc.archiveSourceRpc, ({ id }, { paseo }) => service.archive(paseo, id));
  return async () => { clearInterval(sweep); receiver.dispose(); await service.dispose(); };
}
