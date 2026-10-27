import type { PluginClientContext } from '@getpaseo/plugin/client';
import { identityRpc } from '../shared/transfer';

type HostRpc = PluginClientContext['rpc'];
export function createFederation() {
  const endpoints = new Map<string, HostRpc>();
  const listeners = new Set<() => void>();
  let revision = 0;
  function notify() { revision++; for (const listener of listeners) listener(); }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => revision,
    has: (id: string) => endpoints.has(id),
    rpc(id: string): HostRpc {
      return (contract, input) => {
        const call = endpoints.get(id);
        if (!call) throw new Error('Transfer is unavailable on this host. Connect it in Paseo and update Transfer on both hosts.');
        return call(contract, input);
      };
    },
    register(id: string, rpc: HostRpc) {
      endpoints.set(id, rpc); notify();
      return () => { if (endpoints.get(id) === rpc) { endpoints.delete(id); notify(); } };
    },
  };
}
const key = Symbol.for('yboyer.transfert.federation.v1');
const realm = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createFederation> };
export const federation = realm[key] ??= createFederation();

export function registerHost(client: Pick<PluginClientContext, 'rpc'>) {
  let disposed = false, pending = false;
  let unregister: (() => void) | undefined;
  async function identify() {
    if (disposed || pending || unregister) return;
    pending = true;
    try {
      const identity = await client.rpc(identityRpc, {});
      if (!disposed) unregister = federation.register(identity.serverId, (contract, input) => client.rpc(contract, input));
    } catch { /* Retry while this installation loads or reconnects. */ }
    finally { pending = false; }
  }
  void identify();
  const timer = setInterval(() => void identify(), 5000);
  return () => { disposed = true; clearInterval(timer); unregister?.(); };
}
