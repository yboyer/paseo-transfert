import {
  CHUNK_BYTES, exportStartRpc, exportChunkRpc, exportSettleRpc, exportArchiveRpc,
  beginRpc, chunkRpc, finishRpc, verifyRpc, type DestinationInput, type Job,
} from '../shared/transfer';
import { federation } from './federation';

type Run = { job: Job; sourceId: string; targetId: string; token?: string };
export function createTransferClient(rpc = federation.rpc) {
  const runs = new Map<string, Run>();
  return {
    async start(sourceId: string, targetId: string, previewId: string, destination: DestinationInput) {
      if (sourceId === targetId) throw new Error('Choose a different host.');
      const source = rpc(sourceId), target = rpc(targetId);
      const exported = await source(exportStartRpc, { previewId, serverId: targetId });
      const run: Run = { job: exported.job, sourceId, targetId };
      runs.set(run.job.id, run);
      void (async () => {
        try {
          const { token } = await target(beginRpc, { ...destination, id: exported.transferId, bytes: run.job.total, digest: exported.digest });
          run.token = token;
          for (let offset = 0; offset < run.job.total; offset += CHUNK_BYTES) {
            const { data } = await source(exportChunkRpc, { id: run.job.id, offset });
            const { received } = await target(chunkRpc, { token, offset, data });
            if (received !== Math.min(offset + CHUNK_BYTES, run.job.total)) throw new Error('Destination chunk acknowledgment mismatch.');
            run.job = { ...run.job, sent: received };
          }
          run.job = { ...run.job, phase: 'restoring' };
          const receipt = await target(finishRpc, { token });
          if (receipt.transferId !== exported.transferId || receipt.digest !== exported.digest) throw new Error('Destination receipt mismatch.');
          run.job = await source(exportSettleRpc, { id: run.job.id, receipt });
        } catch (failure) {
          const error = failure instanceof Error ? failure.message : String(failure);
          run.job = { ...run.job, phase: 'failed', error };
          try { await source(exportSettleRpc, { id: run.job.id, error }); } catch { /* The source expires abandoned exports if its connection is lost. */ }
        }
      })();
      return { ...run.job };
    },
    has(id: string) { return runs.has(id); },
    status(id: string) {
      const run = runs.get(id);
      if (!run) throw new Error('Transfer tracking is unavailable after reloading Paseo. Check the destination before retrying.');
      return { ...run.job };
    },
    async archive(id: string) {
      const run = runs.get(id);
      if (!run?.token || run.job.phase !== 'complete') throw new Error('Finish and verify the copy before archiving.');
      const receipt = await rpc(run.targetId)(verifyRpc, { token: run.token });
      run.job = await rpc(run.sourceId)(exportArchiveRpc, { id, receipt, confirm: true });
      return { ...run.job };
    },
  };
}
// A shared coordinator keeps transfers alive when their screen or selected host changes.
const key = Symbol.for('yboyer.transfert.runs.v1');
const realm = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createTransferClient> };
export const connectedTransfer = realm[key] ??= createTransferClient();
