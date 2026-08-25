import type { ExtractorContext, RepoInventory, ScannedFile } from '../src/model/types.js';

export function file(path: string, content: string, extra: Partial<ScannedFile> = {}): ScannedFile {
  return { path, content, size: content.length, ...extra };
}

export function ctx(files: ScannedFile[], inv: Partial<RepoInventory> = {}): ExtractorContext {
  const inventory: RepoInventory = {
    root: '/repo', filesScanned: files.length, filesIgnored: 0, filesSkippedSensitive: [], languages: {}, frameworks: [],
    topLevelDirs: [], hasGit: false, sources: {}, allPaths: files.map((f) => f.path), ...inv,
  };
  return { files, inventory, perPackageDependencies: false };
}
