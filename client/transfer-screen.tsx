import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  targetsRpc, previewRpc, inspectDestinationRpc, startRpc, statusRpc, archiveSourceRpc,
  type Preview, type Job,
} from '../shared/transfer';

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function formatBytes(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }

export function TransferScreen({ theme, layout, params, host, navigation }: PluginScreenProps) {
  const paseo = usePaseo();
  const targets = useRpc(targetsRpc);
  const prepare = useRpc(previewRpc);
  const inspect = useRpc(inspectDestinationRpc);
  const start = useRpc(startRpc);
  const status = useRpc(statusRpc);
  const archive = useRpc(archiveSourceRpc);
  const [sources, setSources] = useState<{ id: string; title: string; directory: string }[]>([]);
  const [hosts, setHosts] = useState<{ serverId: string; label: string }[]>([]);
  const [workspaceId, setWorkspaceId] = useState(params.workspaceId || '');
  const [serverId, setServerId] = useState('');
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [move, setMove] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [destination, setDestination] = useState<{ root: string; repository: string; worktreeParent: string } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const running = job?.phase === 'sending' || job?.phase === 'restoring';
  const locked = busy || !!running;
  const colors = theme.colors;
  const styles = {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: layout.compact ? 16 : 28, gap: 18, maxWidth: 900, width: '100%' as const, alignSelf: 'center' as const },
    card: { backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: 18, gap: 12 },
    title: { color: colors.foreground, fontSize: 24, fontWeight: '700' as const },
    heading: { color: colors.foreground, fontSize: 17, fontWeight: '600' as const },
    text: { color: colors.foreground, fontSize: 14, lineHeight: 21 },
    muted: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    input: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0, color: colors.foreground, padding: 12, borderRadius: 8 },
    row: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 8 },
  };
  function Button({ label, onPress, disabled = false, selected = false, danger = false }: { label: string; onPress: () => void; disabled?: boolean; selected?: boolean; danger?: boolean }) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }} disabled={disabled}
      onPress={onPress} style={{ paddingHorizontal: 14, paddingVertical: 11, borderRadius: 8, borderWidth: 1, borderColor: danger ? colors.statusDanger : selected ? colors.accent : colors.border, backgroundColor: selected ? colors.accent : colors.surface2, opacity: disabled ? 0.45 : 1 }}>
      <Text style={{ color: selected ? colors.accentForeground : danger ? colors.statusDanger : colors.foreground, fontWeight: '600' }}>{label}</Text>
    </Pressable>;
  }
  function invalidate() { setPreview(null); setDestination(null); setConfirmed(false); setError(''); }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [available, first] = await Promise.all([targets({}), paseo.workspaces.list({ page: { limit: 100 } })]);
      const workspaces = [...first.entries];
      let cursor = first.pageInfo.nextCursor;
      while (cursor) {
        const page = await paseo.workspaces.list({ page: { limit: 100, cursor } });
        workspaces.push(...page.entries); cursor = page.pageInfo.nextCursor;
      }
      if (cancelled) return;
      setHosts(available);
      if (available.length === 1) setServerId(available[0]!.serverId);
      setSources(workspaces.filter(w => w.projectKind === 'git' && !w.archivingAt).map(w => ({ id: w.id, title: w.title || w.name, directory: w.workspaceDirectory ?? w.projectRootPath })));
    }
    void load().catch(failure => { if (!cancelled) setError(message(failure)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [paseo, targets]);
  useEffect(() => {
    if (!job || !running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await status({ id: job!.id });
        if (cancelled) return;
        setJob(next); setError('');
        if (next.phase === 'sending' || next.phase === 'restoring') timer = setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (!cancelled) { setError(message(failure)); timer = setTimeout(() => void poll(), 3000); }
      }
    }
    timer = setTimeout(() => void poll(), 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job?.id, running, status]);

  return <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
    <View style={{ gap: 6 }}>
      <Text style={styles.title}>Transfer</Text>
      <Text style={styles.muted}>Copy a workspace from {host.label} to another Paseo host.</Text>
    </View>
    {!!error && <View accessibilityRole="alert" style={styles.card}><Text selectable style={{ ...styles.text, color: colors.statusDanger }}>{error}</Text></View>}
    {!job && <>
      <View style={styles.card}>
        <Text style={styles.heading}>1. Source workspace</Text>
        {loading && <Text style={styles.muted}>Loading…</Text>}
        {!loading && !sources.length && <Text style={styles.muted}>No Git workspaces are available on this host.</Text>}
        {sources.map(source => <Pressable key={source.id} disabled={locked} accessibilityRole="button" accessibilityState={{ selected: workspaceId === source.id }}
          onPress={() => { setWorkspaceId(source.id); invalidate(); }} style={{ padding: 12, gap: 3, borderWidth: 1, borderColor: workspaceId === source.id ? colors.accent : colors.border, borderRadius: 8 }}>
          <Text style={styles.text}>{source.title}</Text><Text selectable style={styles.muted}>{source.directory}</Text>
        </Pressable>)}
        <Text style={styles.muted}>Stop agents and commands that write files before transferring.</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>2. Destination</Text>
        <View style={styles.row}>{hosts.map(target => <Button key={target.serverId} label={target.label} selected={serverId === target.serverId} disabled={locked}
          onPress={() => { setServerId(target.serverId); setParent(''); invalidate(); }} />)}</View>
        {!loading && !hosts.length && <Text style={styles.muted}>Connect another host to the source daemon in Paseo. Install Transfer on both hosts.</Text>}
        <Text style={styles.text}>Existing parent directory on the destination host</Text>
        <TextInput accessibilityLabel="Destination parent directory" value={parent} editable={!locked} onChangeText={value => { setParent(value); invalidate(); }} placeholder="/Users/you/Code" placeholderTextColor={colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Text style={styles.text}>New folder name</Text>
        <TextInput accessibilityLabel="New folder name" value={name} editable={!locked} onChangeText={value => { setName(value); invalidate(); }} placeholder="my-local-project" placeholderTextColor={colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Text style={styles.muted}>This folder will contain the Git repository and a worktree. The plugin will create a Paseo workspace for this worktree.</Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.heading}>3. Action</Text>
        <View style={styles.row}><Button label="Copy" selected={!move} disabled={locked} onPress={() => setMove(false)} /><Button label="Move" selected={move} disabled={locked} onPress={() => setMove(true)} /></View>
        <Text style={styles.muted}>{move ? 'The plugin copies and verifies the files. You will then confirm source archiving.' : 'The source remains available. The two copies are independent.'}</Text>
        <Button label={busy ? 'Preparing…' : 'Show preview'} disabled={locked || !workspaceId || !serverId || !parent || !name} onPress={() => void perform(async () => {
          invalidate();
          const target = await inspect({ serverId, parent, name });
          const result = await prepare({ workspaceId });
          setDestination(target); setPreview(result);
        })} />
      </View>
      {preview && destination && <View style={styles.card}>
        <Text style={styles.heading}>Review the transfer</Text>
        <Text selectable style={styles.text}>{preview.title} · {preview.branch} · {preview.head.slice(0, 12)}</Text>
        <Text style={styles.text}>{preview.files.length} files · {formatBytes(preview.bytes)}, including Git history</Text>
        <Text selectable style={styles.muted}>Source: {preview.directory}</Text>
        <Text selectable style={styles.muted}>Destination: {destination.root}</Text>
        <Text selectable style={styles.muted}>Worktree: {destination.worktreeParent}</Text>
        <Text style={styles.muted}>Staged changes are preserved. Conversations and Git-ignored files are excluded.</Text>
        {!!preview.ignored.length && <>
          <Text style={{ ...styles.text, color: colors.statusWarning }}>{preview.ignored.length} ignored files or folders. Moving is blocked to prevent data loss.</Text>
          <ScrollView style={{ maxHeight: 130 }}>{preview.ignored.map(file => <Text key={file} selectable style={styles.muted}>{file}</Text>)}</ScrollView>
        </>}
        <Text style={styles.text}>Included files</Text>
        <ScrollView style={{ maxHeight: 180 }}>{preview.files.map(file => <Text key={file} selectable style={styles.muted}>{file}</Text>)}</ScrollView>
        <Text style={styles.muted}>The preview expires after 15 minutes. Existing folders will not be overwritten.</Text>
        <Button label={move ? 'Copy before moving' : 'Confirm copy'} selected disabled={locked || (move && preview.ignored.length > 0)} onPress={() => void perform(async () => {
          const created = await start({ previewId: preview.id, serverId, parent, name });
          setJob(created); setJobId(created.id);
        })} />
      </View>}
    </>}
    {job && <View style={styles.card}>
      <Text style={styles.heading}>{job.sourceArchived ? 'Move complete' : job.phase === 'complete' ? 'Copy verified' : job.phase === 'failed' ? 'Transfer interrupted' : job.phase === 'restoring' ? 'Restoring and verifying…' : 'Transferring…'}</Text>
      <Text style={styles.text}>{formatBytes(job.sent)} / {formatBytes(job.total)}</Text>
      <Text selectable style={styles.muted}>Tracking ID: {job.id}</Text>
      <Text style={styles.muted}>The transfer continues if you leave this screen. Both daemons must remain running.</Text>
      {!!job.error && <Text selectable style={{ ...styles.text, color: colors.statusDanger }}>{job.error}</Text>}
      {job.phase === 'failed' && <Text style={styles.muted}>The source is preserved. A partial folder may remain at the destination. Use a new folder to retry.</Text>}
      {job.receipt && <>
        <Text selectable style={styles.text}>{job.receipt.directory}</Text>
        {!!navigation && <Button label="Open destination workspace" onPress={() => navigation.openWorkspace({ workspaceId: job.receipt!.workspaceId, serverId: job.destinationServerId })} />}
        {!job.sourceArchived && <>
          <Text style={styles.heading}>Move: archive the source</Text>
          <Text style={styles.muted}>Paseo will archive the source workspace, its agents, and its terminals. If Paseo manages its worktree, it may delete the source files. A worktree created by Transfer stays on disk after archiving.</Text>
          <Button label={confirmed ? '✓ I confirm source archiving' : 'I confirm source archiving'} selected={confirmed} disabled={locked} onPress={() => setConfirmed(value => !value)} />
          <Button label="Verify and archive the source" danger disabled={locked || !confirmed || job.sourceArchived} onPress={() => void perform(async () => {
            setJob(await archive({ id: job.id, confirm: true })); setConfirmed(false);
          })} />
          <Text style={styles.muted}>Both copies must be unchanged. Close the source terminals. Ignored files block archiving.</Text>
        </>}
      </>}
      {!running && <Button label="New transfer" disabled={busy} onPress={() => { setJob(null); setJobId(''); invalidate(); }} />}
    </View>}
    {!running && <View style={styles.card}>
      <Text style={styles.heading}>Resume tracking</Text>
      <Text style={styles.muted}>On the same source host, enter the ID of a transfer from the last hour. Tracking does not survive a plugin restart.</Text>
      <TextInput accessibilityLabel="Transfer ID" value={jobId} onChangeText={setJobId} editable={!busy} autoCapitalize="none" autoCorrect={false} style={styles.input} />
      <Button label="Load transfer status" disabled={busy || !jobId} onPress={() => void perform(async () => { setJob(await status({ id: jobId })); setConfirmed(false); })} />
    </View>}
  </ScrollView>;
}
