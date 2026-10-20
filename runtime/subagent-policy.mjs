import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const projectKey = (cwd) => (process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd));
export const inheritedPolicy = () => ({ model: '', thinking: '' });
export const SUBAGENT_ROLES = {
  explore: 'Inspect code, gather evidence and report findings without making changes.',
  implement: 'Implement a scoped change and run focused tests.',
  review: 'Review changes independently for correctness and regressions.',
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const validModel = (value) => typeof value === 'string' &&
  (value === '' || /^[a-z0-9][a-z0-9._-]{0,99}\/[^\s\x00-\x1f\x7f]{1,300}$/u.test(value));
const validThinking = (value) => value === '' || THINKING_LEVELS.includes(value);
export function validPolicy(value) {
  return Boolean(object(value) &&
    Object.keys(value).every((key) => ['model', 'thinking', 'roles'].includes(key)) &&
    validModel(value.model) && validThinking(value.thinking) &&
    (!Object.hasOwn(value, 'roles') || (object(value.roles) &&
      Object.entries(value.roles).every(([role, policy]) => Object.hasOwn(SUBAGENT_ROLES, role) &&
        object(policy) && Object.keys(policy).every((key) => ['model', 'thinking'].includes(key)) &&
        (!Object.hasOwn(policy, 'model') || validModel(policy.model)) &&
        (!Object.hasOwn(policy, 'thinking') || validThinking(policy.thinking))))));
}
export function effectivePolicy(global, project) {
  const base = project ?? global;
  if (!global.roles && !project?.roles) return base;
  const roles = {};
  for (const role of Object.keys(SUBAGENT_ROLES)) {
    if (!global.roles?.[role] && !project?.roles?.[role]) continue;
    roles[role] = {};
    for (const field of ['model', 'thinking']) {
      const value = project?.roles?.[role]?.[field] || global.roles?.[role]?.[field];
      if (value) roles[role][field] = value;
    }
  }
  return { ...base, roles };
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
  const { role, ...native } = kwargs;
  if (Object.hasOwn(kwargs, 'role') && (typeof role !== 'string' || !Object.hasOwn(SUBAGENT_ROLES, role)))
    throw new Error(`Unknown subagent role. Available roles: ${Object.keys(SUBAGENT_ROLES).join(', ')}.`);
  const selected = policy.roles?.[role];
  const model = selected?.model || policy.model;
  const thinking = selected?.thinking || policy.thinking;
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...native,
  };
}
export function subagentInstruction(cwd, file) {
  const policy = policyFor(cwd, file);
  if (!policy.model && !policy.thinking && !Object.keys(policy.roles || {}).length) return '';
  return [
    '## Prime Agent Studio — subagent defaults',
    'For delegated agents created with rlm.spawn, use these defaults unless the user requests another choice for the task:',
    `- Model: ${policy.model || 'omit the model argument to use the native default model, otherwise inherit the parent model'}.`,
    `- Thinking level: ${policy.thinking || 'inherit the parent thinking level (native model compatibility rules apply)'}.`,
    ...Object.entries(policy.roles || {}).map(([role, defaults]) =>
      `- role="${role}": ${SUBAGENT_ROLES[role]} Model: ${defaults.model || policy.model || 'native default'}; thinking: ${defaults.thinking || policy.thinking || 'inherit'}.`),
    ...(Object.keys(policy.roles || {}).length ? ['Select a configured role with rlm.spawn(..., role="explore"). Explicit model/thinking arguments override the role; role fields override project/global defaults. The Studio removes role before calling the native engine.'] : []),
    'Every rlm.spawn call requires an explicit unique `name` keyword argument.',
    'The Studio supplies these values for omitted model/thinking arguments. Explicit arguments take priority. Do not select another model or thinking level without a task-specific reason. Existing children keep their current settings.',
  ].join('\n');
}
