/**
 * Ignore rules.
 *
 * What: glob-ish matching for the config ignore list (gitignore-style subset: `*`, `**`, `?`).
 * Use:  `const m = compileIgnore(patterns); m('node_modules/x.js') → true`.
 * Depends on: nothing. Paths are repo-relative with forward slashes.
 */
export type Matcher = (relPath: string) => boolean;

function globToRegex(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const anchoredToRoot = g.startsWith('/');
  if (anchoredToRoot) g = g.slice(1);
  if (g.endsWith('/')) g = g.slice(0, -1); // 'dir/' means the directory and everything under it
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // '**/' matches zero or more directories
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^$(){}|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  // Only a leading '/' anchors to the repo root; everything else matches at any depth.
  const prefix = anchoredToRoot ? '^' : '(?:^|/)';
  // A directory pattern also matches everything beneath it.
  return new RegExp(`${prefix}${re}(?:/.*)?$`);
}

export function compileIgnore(patterns: string[]): Matcher {
  const regs = patterns.filter(Boolean).map(globToRegex);
  return (relPath: string) => {
    const p = relPath.replace(/\\/g, '/');
    return regs.some((r) => r.test(p));
  };
}
