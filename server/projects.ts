import path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import type { Project } from '../shared/transfer';
import { sourceDirectory, assertParents, sha256 } from './snapshot';

type Paseo = PluginHandlerContext['paseo'];
export async function listProjects(paseo: Paseo): Promise<Project[]> {
  const { projects } = await paseo.projects.list();
  return projects.filter(project => project.projectKind === 'git').map(project => ({
    id: project.projectId, name: project.projectCustomName || project.projectDisplayName, directory: project.projectRootPath,
  }));
}
export async function findProject(paseo: Paseo, id: string) {
  const project = (await listProjects(paseo)).find(project => project.id === id);
  if (!project) throw new Error('Destination project is unavailable. Reload the project list.');
  return { ...project, directory: await sourceDirectory(project.directory) };
}
export async function projectDestination(project: Project, name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) throw new Error('Choose a simple name for the new workspace.');
  const repository = await sourceDirectory(project.directory);
  // Keep the new worktree outside the project checkout so its files and status stay unchanged.
  const relative = `.paseo-transfers/${sha256(repository).slice(0, 16)}/${name}`;
  await assertParents(path.dirname(repository), relative);
  const root = path.join(path.dirname(repository), relative);
  const existing = await lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) throw new Error('A transfer with this workspace name already exists. Choose another name.');
  return { root, repository, worktreeParent: path.join(root, 'worktree'), projectId: project.id, projectName: project.name };
}
