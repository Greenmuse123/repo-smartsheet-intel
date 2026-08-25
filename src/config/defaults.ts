/**
 * Node-free defaults shared by the CLI config loader and the browser demo.
 * Kept dependency-free so it can be bundled for the browser.
 */
export const ALL_EXTRACTORS = [
  'todo-comments', 'readme-checklist', 'changelog', 'manifests',
  'ci', 'tests', 'codeowners', 'adr', 'risk-heuristics',
] as const;

export const DEFAULT_IGNORE = [
  // secrets & credentials
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '*.crt', 'credentials*', 'secrets*',
  '.npmrc', '.pypirc', '.netrc', '.aws/**', '.ssh/**', 'service-account*.json',
  // dependencies / vendor
  'node_modules/**', 'vendor/**', 'bower_components/**', '.venv/**', 'venv/**',
  'site-packages/**', 'Pods/**',
  // build output & caches
  'dist/**', 'build/**', 'out/**', '.next/**', 'target/**', 'bin/**', 'obj/**',
  '__pycache__/**', '.cache/**', 'coverage/**', '.turbo/**', '.parcel-cache/**',
  // VCS / tool state
  '.git/**', '.hg/**', '.svn/**', '.idea/**', '.vscode/**', '.repo-smartsheet/**',
  // binaries & large irrelevant content
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.pdf', '*.zip', '*.tar', '*.gz',
  '*.7z', '*.mp3', '*.mp4', '*.mov', '*.wav', '*.woff', '*.woff2', '*.ttf', '*.eot',
  '*.exe', '*.dll', '*.so', '*.dylib', '*.wasm', '*.min.js', '*.min.css', '*.map',
  '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock',
  '*.sqlite', '*.db', '*.log',
];
