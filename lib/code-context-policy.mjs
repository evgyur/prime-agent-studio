import { extname } from 'node:path';

const SOURCE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.cs', '.rs', '.go', '.vue', '.svelte']);
// Source modules may HANDLE credentials; actual credential stores remain excluded.
export function sensitiveCodePath(path) {
  if (/(^|\/)(?:\.env[^/]*|\.ssh|\.aws|id_rsa[^/]*|id_ed25519[^/]*)(\/|$)|\.(?:pem|key|p12|pfx|keystore)$/i.test(path)) return true;
  return !SOURCE.has(extname(path).toLowerCase()) && /(^|\/)(?:credentials?[^/]*|secrets?[^/]*|passwords?[^/]*|(?:keys?|tokens?)(?:\.[^/]*)?)(\/|$)|(?:^|[/._-])(?:private[-_]?key|api[-_]?key)(?:[._/-]|$)/i.test(path);
}
