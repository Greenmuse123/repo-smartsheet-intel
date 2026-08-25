/**
 * File classification.
 *
 * What: cheap, deterministic labels for a path - language, whether it is a manifest,
 *       CI config, test, README, changelog, ADR, CODEOWNERS.
 * Use:  `classify('src/a.test.ts') → { language: 'TypeScript', isTest: true, ... }`.
 * Depends on: nothing.
 */
export interface FileClass {
  language?: string;
  isSource: boolean;
  isTest: boolean;
  isReadme: boolean;
  isChangelog: boolean;
  isManifest: boolean;
  isCi: boolean;
  isCodeowners: boolean;
  isAdr: boolean;
  isDoc: boolean;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby', php: 'PHP', cs: 'C#',
  c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', swift: 'Swift', scala: 'Scala', sh: 'Shell', ps1: 'PowerShell',
  sql: 'SQL', yml: 'YAML', yaml: 'YAML', json: 'JSON', md: 'Markdown', toml: 'TOML', html: 'HTML', css: 'CSS', vue: 'Vue', svelte: 'Svelte',
};
const SOURCE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs', 'c', 'h', 'cpp', 'hpp', 'swift', 'scala', 'sh', 'ps1', 'sql', 'vue', 'svelte', 'yml', 'yaml', 'toml', 'html', 'css']);
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'cargo.toml', 'gemfile', 'pom.xml', 'build.gradle', 'composer.json', 'pipfile']);

export function classify(relPath: string): FileClass {
  const p = relPath.replace(/\\/g, '/');
  const base = p.split('/').pop() ?? p;
  const lower = base.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop()! : '';
  const isTest = /(^|\/)(tests?|__tests__|spec|specs|e2e)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(lower) || /^test_.*\.py$/.test(lower) || /_test\.(go|py)$/.test(lower);
  return {
    language: LANG_BY_EXT[ext],
    isSource: SOURCE_EXT.has(ext),
    isTest,
    isReadme: /^readme(\.|$)/.test(lower),
    isChangelog: /^(changelog|changes|history|release[-_]?notes)(\.|$)/.test(lower),
    isManifest: MANIFESTS.has(lower),
    isCi: /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /(^|\/)(\.gitlab-ci\.yml|bitbucket-pipelines\.yml|azure-pipelines\.yml|jenkinsfile|\.circleci\/config\.yml)$/i.test(p),
    isCodeowners: lower === 'codeowners',
    isAdr: /(^|\/)(adrs?|decisions)\/[^/]+\.md$/i.test(p) || /^adr-\d+.*\.md$/i.test(lower),
    isDoc: ext === 'md' || /(^|\/)docs?\//i.test(p),
  };
}
