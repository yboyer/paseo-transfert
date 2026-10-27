import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHostClient, createHostChannelTransport } from '@getpaseo/client/node';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { PluginRpcContract } from '@getpaseo/plugin';
import type { z } from 'zod';
import { PLUGIN_ID } from '../shared/transfer';

export async function connectDestination(serverId: string) {
  // PaseoApi has no cross-host plugin RPC method. Isolate the version-pinned Node transport here.
  const home = process.env.PASEO_HOME || path.join(homedir(), '.paseo');
  const state = JSON.parse(await readFile(path.join(home, 'paseo.pid'), 'utf8')) as { listen?: string; serverId?: string };
  if (!state.listen) throw new Error('Cannot find the local Paseo daemon.');
  if (state.serverId === serverId) throw new Error('Choose a different host.');
  const endpoint = state.listen.replace(/^0\.0\.0\.0:/, '127.0.0.1:').replace(/^\[::\]:/, '[::1]:');
  const origin = createHostClient(endpoint, {
    clientId: `transfert-${randomUUID()}`, clientType: 'cli', appVersion: '0.13.0',
    localCredential: async () => (await readFile(path.join(home, 'local-credential'), 'utf8')).trim(),
    ...(process.env.PASEO_PASSWORD ? { password: process.env.PASEO_PASSWORD } : {}),
    connectTimeoutMs: 15_000, reconnect: { enabled: false },
  });
  let remote: DaemonClient | undefined;
  try {
    await origin.connect();
    const hosts = await origin.listHosts();
    if (!hosts.hosts.some(host => host.serverId === serverId && host.enabled && host.status === 'online')) throw new Error('Destination host is not connected to the source daemon.');
    const scopeId = `transfert-${randomUUID()}`;
    const routeId = await origin.openHostRoute(serverId, scopeId);
    remote = new DaemonClient({
      url: 'ws://paseo-host-route/ws', clientId: `transfert-${randomUUID()}`, clientType: 'cli', appVersion: '0.13.0',
      transportFactory: createHostChannelTransport(origin, serverId, scopeId, routeId),
      reconnect: { enabled: false }, connectTimeoutMs: 15_000,
    });
    await remote.connect();
    const connected = remote;
    return {
      call<I extends z.ZodType, O extends z.ZodType>(contract: PluginRpcContract<I, O>, input: z.input<I>) {
        return connected.invokePluginRpc(PLUGIN_ID, contract.name, contract.input.parse(input)).then(value => contract.output.parse(value));
      },
      async close() { await connected.close(); await origin.close(); },
    };
  } catch (error) { await remote?.close(); await origin.close(); throw error; }
}
export type DestinationConnection = Awaited<ReturnType<typeof connectDestination>>;
