import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const PLUGIN_ID = 'transfert';
export const MAX_BYTES = 128 * 1024 * 1024;
export const MAX_FILES = 20_000;
export const CHUNK_BYTES = 192 * 1024;
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const idSchema = z.string().uuid();
export const entrySchema = z.object({
  path: z.string().min(1).max(4096),
  kind: z.enum(['file', 'symlink']),
  executable: z.boolean(),
  data: z.string().max(MAX_BYTES * 2),
});
export const snapshotSchema = z.object({
  version: z.literal(1),
  head: z.string().regex(/^[a-f0-9]{40,64}$/),
  branch: z.string(),
  refs: z.string(),
  stagedPatch: z.string(),
  entries: z.array(entrySchema).max(MAX_FILES),
  ignored: z.array(z.string()).max(MAX_FILES),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const archiveSchema = z.object({ snapshot: snapshotSchema, bundle: z.string() });
export const previewSchema = z.object({
  id: idSchema,
  workspaceId: z.string(),
  title: z.string(),
  directory: z.string(),
  branch: z.string(),
  head: z.string(),
  fingerprint: digestSchema,
  bytes: z.number(),
  files: z.array(z.string()),
  ignored: z.array(z.string()),
  expiresAt: z.string(),
});
export type Preview = z.infer<typeof previewSchema>;
export const receiptSchema = z.object({
  transferId: idSchema,
  digest: digestSchema,
  workspaceId: z.string(),
  directory: z.string(),
  repository: z.string(),
});
export type Receipt = z.infer<typeof receiptSchema>;
export const jobSchema = z.object({
  id: idSchema,
  destinationServerId: z.string(),
  phase: z.enum(['sending', 'restoring', 'complete', 'failed']),
  sent: z.number(),
  total: z.number(),
  error: z.string().nullable(),
  receipt: receiptSchema.nullable(),
  sourceArchived: z.boolean(),
});
export type Job = z.infer<typeof jobSchema>;

export const targetsRpc = defineRpc({
  name: 'transfer.targets', input: z.object({}),
  output: z.array(z.object({ serverId: z.string(), label: z.string() })),
});
export const previewRpc = defineRpc({
  name: 'transfer.preview', input: z.object({ workspaceId: z.string() }), output: previewSchema,
});
export const destinationRpc = defineRpc({
  name: 'transfer.destination', input: z.object({ parent: z.string(), name: z.string() }),
  output: z.object({ root: z.string(), repository: z.string(), worktreeParent: z.string() }),
});
export const inspectDestinationRpc = defineRpc({
  name: 'transfer.inspect-destination',
  input: z.object({ serverId: z.string(), parent: z.string(), name: z.string() }),
  output: destinationRpc.output,
});
export const beginRpc = defineRpc({
  name: 'transfer.receive-begin',
  input: z.object({ id: idSchema, parent: z.string(), name: z.string(), bytes: z.number().int().positive().max(MAX_BYTES), digest: digestSchema }),
  output: z.object({ token: idSchema }),
});
export const chunkRpc = defineRpc({
  name: 'transfer.receive-chunk',
  input: z.object({ token: idSchema, offset: z.number().int().nonnegative(), data: z.string().max(CHUNK_BYTES * 2) }),
  output: z.object({ received: z.number() }),
});
export const finishRpc = defineRpc({
  name: 'transfer.receive-finish', input: z.object({ token: idSchema }), output: receiptSchema,
});
export const verifyRpc = defineRpc({
  name: 'transfer.receive-verify', input: z.object({ token: idSchema }), output: receiptSchema,
});
export const startRpc = defineRpc({
  name: 'transfer.start',
  input: z.object({ previewId: idSchema, serverId: z.string(), parent: z.string(), name: z.string() }),
  output: jobSchema,
});
export const statusRpc = defineRpc({ name: 'transfer.status', input: z.object({ id: idSchema }), output: jobSchema });
export const archiveSourceRpc = defineRpc({
  name: 'transfer.archive-source', input: z.object({ id: idSchema, confirm: z.literal(true) }), output: jobSchema,
});
