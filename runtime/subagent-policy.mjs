import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const projectKey = (cwd) => (process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd));
export const inheritedPolicy = () => ({ model: '', thinking: '' });
// Per-role routing was removed in 4.4.1. Legacy saved `roles` objects are
// still accepted for backward compatibility but never applied.
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const validModel = (value) => typeof value === 'string' &&
  (value === '' || /^[a-z0-9][a-z0-9._-]{0,99}\/[^\s\x00-\x1f\x7f]{1,300}$/u.test(value));
const validThinking = (value) => value === '' || THINKING_LEVELS.includes(value);
export function validPolicy(value) {
  return Boolean(object(value) &&
    Object.keys(value).every((key) => ['model', 'thinking', 'roles'].includes(key)) &&
    validModel(value.model) && validThinking(value.thinking) &&
    (!Object.hasOwn(value, 'roles') || object(value.roles)));
}
export function effectivePolicy(global, project) {
  const base = project ?? global;
  // Legacy `roles` are accepted by validPolicy/readPolicyFile but never
  // applied: only the general model/thinking defaults take effect.
  return { model: base.model, thinking: base.thinking };
}
export function readPolicyFile(file) {
  const empty = { version: 1, revision: '', global: inheritedPolicy(), projects: {} };
  if (!file) return empty;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error();
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (
      data.version !== 1 ||
      typeof data.revision !== 'string' ||
      !validPolicy(data.global) ||
      !data.projects ||
      typeof data.projects !== 'object' ||
      Array.isArray(data.projects) ||
      !Object.values(data.projects).every(validPolicy)
    )
      throw new Error();
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return empty;
    throw new Error(
      'Les réglages des sous-agents du Studio sont illisibles. Corrigez la configuration avant de déléguer.',
    );
  }
}
export function policyFor(cwd, file = process.env.PRIME_STUDIO_SUBAGENT_POLICY) {
  const data = readPolicyFile(file);
  return effectivePolicy(data.global, data.projects[projectKey(cwd)]);
}
export function applySubagentDefaults(cwd, kwargs, file) {
  const policy = policyFor(cwd, file);
  // Compatibility: old conversations may still pass `role`. It is stripped
  // silently and never selects a model; only general defaults apply.
  const { role: _ignoredRole, ...native } = kwargs;
  const model = policy.model;
  const thinking = policy.thinking;
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...native,
  };
}
export function subagentInstruction(cwd, file) {
  const policy = policyFor(cwd, file);
  if (!policy.model && !policy.thinking) return '';
  return [
    '## Prime Agent Studio — subagent defaults',
    'For delegated agents created with rlm.spawn, use these defaults unless the user requests another choice for the task:',
    `- Model: ${policy.model || 'omit the model argument to use the native default model, otherwise inherit the parent model'}.`,
    `- Thinking level: ${policy.thinking || 'inherit the parent thinking level (native model compatibility rules apply)'}.`,
    'Every rlm.spawn call requires an explicit unique `name` keyword argument.',
    'The Studio supplies these values for omitted model/thinking arguments. Explicit arguments take priority. Do not select another model or thinking level without a task-specific reason. Existing children keep their current settings.',
  ].join('\n');
}
