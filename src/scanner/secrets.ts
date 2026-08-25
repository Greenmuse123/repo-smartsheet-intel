/**
 * Secret detection + redaction.
 *
 * What: two layers. (1) `looksSensitive(path)` blocks whole files that are credentials by
 *       nature. (2) `redact(text)` scrubs token-shaped strings from any excerpt before it
 *       can reach Smartsheet, a log line, or an LLM.
 * Use:  called by the scanner (files) and the normalizer (excerpts).
 * Rule: we never log what was redacted — only that redaction happened.
 */
const SENSITIVE_PATH = [
  /(^|\/)\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(credentials|secrets?)[^/]*$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|htpasswd)$/i,
  /(^|\/)service-?account[^/]*\.json$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, '[REDACTED KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED API KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]'],
  [/\b(api[_-]?key|secret|token|password|passwd|pwd|authorization)\b(\s*[:=]\s*|\s+)["']?([^\s"',;]{6,})["']?/gi, '$1=[REDACTED]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
];

export function looksSensitive(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  return SENSITIVE_PATH.some((r) => r.test(p));
}

export interface RedactResult { text: string; redactions: number }

export function redact(text: string): RedactResult {
  let out = text;
  let n = 0;
  for (const [re, rep] of SECRET_PATTERNS) {
    out = out.replace(re, (...m) => { n++; return typeof rep === 'string' ? rep.replace('$1', m[1] ?? '') : rep; });
  }
  return { text: out, redactions: n };
}
