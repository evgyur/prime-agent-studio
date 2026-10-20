import {
  t as tr,
  bindText,
  bindAttribute,
  translatedOption,
  onLanguageChange,
  translateKnown,
} from './i18n.js';
import { thinkingLabels } from './reasoning.js';

export function createSubagentSettings({
  api,
  root,
  getModels,
  openModelPicker,
  icon,
  toast,
  project = false,
  prefix: prefixOverride,
  instanceId,
}) {
  // Scoped prefix for multi-instance hosts. Default preserves legacy IDs.
  // Clones pass a unique prefix (e.g. `tool-agents-<nonce>--project-subagent`)
  // so model/thinking/save IDs never collide across instances. All lookups
  // stay scoped to `root`, so duplicate legacy IDs cannot leak across roots.
  const prefix = prefixOverride || (project ? 'project-subagent' : 'default-subagent');
  const saveId = !project && !prefixOverride ? 'save-subagent-defaults' : `${prefix}-save`;
  void instanceId;
  let data = null,
    cwd = '',
    busy = false,
    generation = 0,
    needsLoad = true;
  let context = {},
    draft = { model: '', thinking: '' };
  root.innerHTML = `
    <form class="subagent-form">
      <div class="subagent-heading">
        <h3>${project ? tr('ui.sous_agents_du_projet') : tr('agents.subagents')}</h3>
        ${
          project
            ? '<select class="subagent-scope" aria-label="Réglages des sous-agents du projet" data-i18n-aria-label="ui.reglages_des_sous_agents_du_projet"><option value="global" data-i18n="agents.global">Globaux</option><option value="project" data-i18n="ui.ce_projet">Ce projet</option></select>'
            : `<button id="${saveId}" class="primary-button subagent-save" type="submit" data-i18n="ui.enregistrer">Enregistrer</button>`
        }
      </div>
      <fieldset class="subagent-fields">
        <div class="subagent-controls">
          <div class="subagent-model-field"><label id="${prefix}-model-label" data-i18n="ui.modele">Modèle</label>
            <button id="${prefix}-model" class="model-picker-button" type="button" aria-haspopup="dialog" aria-controls="model-dialog" aria-expanded="false">
              <span class="subagent-model-icon"></span>
              <span class="model-picker-selection"><span class="model-picker-name"></span><span class="model-picker-provider"></span></span>
              <span class="model-picker-chevron"></span>
            </button>
          </div>
          <div class="subagent-thinking-field">
            <label for="${prefix}-thinking" data-i18n="ui.reflexion_3">Réflexion</label>
            <select id="${prefix}-thinking"></select>
          </div>
        </div>
      </fieldset>
      <p class="subagent-status" role="status"></p>
      ${project ? '' : '<p class="model-defaults-note" data-i18n="ui.valeurs_par_defaut_pour_tous_les_projets_les_reglages_propres_a_u">Valeurs par défaut pour tous les projets. Les réglages propres à un projet se trouvent dans l’onglet Agents d’une session. Les choix explicites restent prioritaires ; les sous-agents déjà créés conservent leurs réglages.</p>'}
      <p class="subagent-error form-error" role="alert" hidden></p>
      <button class="subagent-reload inspector-refresh" type="button" hidden data-i18n="ui.recharger_les_reglages">Recharger les réglages</button>
    </form>`;
  const $ = (selector) => root.querySelector(selector);
  // Instance prefixes embed tool ids (`tool:agents:<nonce>`); raw colons are
  // valid in HTML ids and getElementById, but `#a:b` parses as pseudo-classes
  // in querySelector. Escape logical IDs (native CSS.escape in browsers).
  const escapeCssId = (value) =>
    typeof CSS !== 'undefined' && CSS?.escape
      ? CSS.escape(value)
      : String(value).replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`);
  const byId = (id) => root.querySelector(`#${escapeCssId(id)}`);
  bindText($('.subagent-heading h3'), () => tr(project ? 'ui.sous_agents_du_projet' : 'agents.subagents'));
  const modelButton = byId(`${prefix}-model`),
    thinkingSelect = byId(`${prefix}-thinking`);
  $('.subagent-model-icon').append(icon('model'));
  $('.model-picker-chevron').append(icon('chevron'));
  byId(`${prefix}-model-label`).setAttribute('for', modelButton.id);
  const option = (value, label) => translatedOption(label, value);

  // Role overrides are sparse: empty fields inherit without pinning a global value.
  const roles = ['explore', 'implement', 'review'];
  const roleFields = new Map();
  const roleSection = document.createElement('div');
  roleSection.className = 'subagent-roles';
  const roleNote = document.createElement('p');
  roleNote.className = 'model-defaults-note';
  bindText(roleNote, () => tr('routing.rolesNote'));
  roleSection.append(roleNote);
  for (const role of roles) {
    const row = document.createElement('div');
    row.className = 'subagent-role-row';
    const title = document.createElement('div');
    title.className = 'subagent-role-title';
    const label = document.createElement('strong');
    const hint = document.createElement('small');
    bindText(label, () => tr(`routing.${role}`));
    bindText(hint, () => tr(`routing.${role}Note`));
    title.append(label, hint);
    const model = modelButton.cloneNode(true);
    model.removeAttribute('id');
    model.dataset.roleModel = role;
    const thinking = document.createElement('select');
    thinking.dataset.roleThinking = role;
    bindAttribute(thinking, 'aria-label', () => `${tr(`routing.${role}`)} · ${tr('ui.reflexion_3')}`);
    const change = () => {
      const value = {};
      if (model.value) value.model = model.value;
      const selected = getModels().find((entry) => entry.id === (model.value || inheritedRoleModel(role)));
      if (thinking.value && (!selected || (selected.thinkingLevels || (selected.reasoning ? Object.keys(thinkingLabels) : ['off'])).includes(thinking.value))) value.thinking = thinking.value;
      draft.roles = { ...draft.roles };
      if (Object.keys(value).length) draft.roles[role] = value;
      else delete draft.roles[role];
      if (!Object.keys(draft.roles).length) delete draft.roles;
      renderRoles();
      if (project) void save();
    };
    thinking.onchange = change;
    model.onclick = () => {
      if (busy || !data || model.matches(':disabled')) return;
      const turn = generation;
      openModelPicker({
        button: model,
        value: model.value,
        get title() { return `${tr(`routing.${role}`)} · ${tr('ui.modele')}`; },
        get defaultLabel() { return tr('routing.inherit'); },
        get defaultDetail() { return inheritedRoleName(role); },
        onSelect(id) {
          if (turn !== generation || busy || !data || model.matches(':disabled')) return;
          model.value = id || '';
          change();
        },
      });
    };
    // Title and hint above; model and reasoning below, in the same columns as
    // the base Model / Reasoning row of this form (its responsive rules apply).
    const controls = document.createElement('div');
    controls.className = 'subagent-controls subagent-role-controls';
    controls.append(model, thinking);
    row.append(title, controls);
    roleSection.append(row);
    roleFields.set(role, { model, thinking });
  }
  $('.subagent-fields').append(roleSection);
  function inheritedRoleModel(role) {
    return (project ? data?.global?.roles?.[role]?.model : '') || draft.model || context.mainModel || '';
  }
  function inheritedRoleName(role) {
    const id = inheritedRoleModel(role);
    return getModels().find((entry) => entry.id === id)?.name || id || tr('ui.modele_natif_sinon_parent');
  }
  function renderRoles() {
    for (const [role, fields] of roleFields) {
      const value = draft.roles?.[role] || {};
      const selected = getModels().find((entry) => entry.id === value.model);
      const unavailable = value.model && (!selected || selected.available === false || selected.availability === 'unavailable');
      fields.model.value = value.model || '';
      bindText(fields.model.querySelector('.model-picker-name'), () => selected?.name ||
        (value.model ? tr('common.unavailable', { value1: value.model }) : tr('routing.inherit')));
      bindText(fields.model.querySelector('.model-picker-provider'), () => unavailable ? tr('ui.modele_indisponible') :
        selected?.provider || inheritedRoleName(role));
      bindAttribute(fields.model, 'title', () => value.model || inheritedRoleModel(role) || tr('routing.inherit'));
      bindAttribute(fields.model, 'aria-label', () => `${tr(`routing.${role}`)} · ${tr('ui.modele')}: ${
        selected?.name || value.model || tr('routing.inherit')}${selected ? ` · ${selected.id}` : ''}${unavailable ? ` · ${tr('ui.modele_indisponible')}` : ''}`);
      fields.thinking.replaceChildren(option('', () => tr('routing.inherit')));
      const model = getModels().find((entry) => entry.id === (value.model || inheritedRoleModel(role)));
      const levels = model ? model.thinkingLevels || (model.reasoning ? Object.keys(thinkingLabels) : ['off']) : Object.keys(thinkingLabels);
      for (const level of levels) fields.thinking.append(option(level, () => thinkingLabels[level] || level));
      if (value.thinking && !levels.includes(value.thinking)) {
        const missing = option(value.thinking, () => tr('common.unavailable', { value1: thinkingLabels[value.thinking] || value.thinking }));
        missing.disabled = true;
        fields.thinking.append(missing);
      }
      fields.thinking.value = value.thinking || '';
    }
  }


  function error(message = '') {
    bindText($('.subagent-error'), () => translateKnown(message));
    $('.subagent-error').hidden = !message;
  }
  function controls() {
    const disabled = busy || !data || (project && (context.readOnly || !context.online));
    $('.subagent-fields').hidden = project && (!data || $('.subagent-scope').value === 'global');
    $('.subagent-fields').disabled = disabled;
    if (project) $('.subagent-scope').disabled = disabled;
    else if ($('.subagent-save')) $('.subagent-save').disabled = disabled;
  }
  function render(preserve = true) {
    const model = getModels().find((m) => m.id === draft.model);
    const name =
      model?.name ||
      (draft.model ? tr('common.unavailable', { value1: draft.model }) : tr('ui.defaut_du_moteur'));
    modelButton.value = draft.model;
    bindText($('.model-picker-name'), () => name);
    bindText(
      $('.model-picker-provider'),
      () => model?.provider || (draft.model ? tr('ui.modele_indisponible') : tr('ui.modele_natif_sinon_parent')),
    );
    bindAttribute(modelButton, 'title', () => draft.model || tr('ui.modele_natif_sinon_parent'));
    bindAttribute(modelButton, 'aria-label', () =>
      tr('ui.modele_des_sous_agents', { value1: name, value2: model ? ', ' + model.id : '' }),
    );
    const levels = model
      ? model.thinkingLevels || (model.reasoning ? Object.keys(thinkingLabels) : ['off'])
      : Object.keys(thinkingLabels);
    thinkingSelect.replaceChildren(option('', () => tr('ui.niveau_parent')));
    for (const level of levels) thinkingSelect.append(option(level, thinkingLabels[level] || level));
    if (draft.thinking && !levels.includes(draft.thinking)) {
      if (preserve) {
        const missing = option(draft.thinking, () =>
          tr('common.unavailable', { value1: thinkingLabels[draft.thinking] || draft.thinking }),
        );
        missing.disabled = true;
        thinkingSelect.append(missing);
      } else draft.thinking = '';
    }
    thinkingSelect.value = draft.thinking;
    renderRoles();
    if (project) $('.subagent-scope').value = data?.project === null ? 'global' : 'project';
    controls();
  }
  function status(message) {
    bindText($('.subagent-status'), () => message);
  }
  function savedStatus() {
    status(() =>
      project
        ? tr('ui.prochaines_delegations_2', {
            value1: data.project === null ? tr('ui.reglages_globaux') : tr('ui.reglages_du_projet'),
          })
        : tr('ui.applique_aux_prochaines_delegations_dans_tous_les_projets'),
    );
  }
  const endpoint = () =>
    project ? `/api/project-subagent-defaults?cwd=${encodeURIComponent(cwd)}` : '/api/subagent-defaults';
  async function load() {
    const turn = ++generation;
    busy = true;
    needsLoad = false;
    error();
    status(() => tr('ui.chargement_des_reglages'));
    controls();
    try {
      const response = await api(endpoint());
      if (turn !== generation) return;
      data = response;
      draft = { ...(project ? data.effective : data.global) };
      // Preserve sparse project role overrides rather than copying inherited roles.
      if (project) draft.roles = { ...data.project?.roles };
      $('.subagent-reload').hidden = true;
      render();
      savedStatus();
    } catch (e) {
      if (turn !== generation) return;
      data = null;
      status(() => tr('ui.reglages_indisponibles'));
      error(() =>
        e.status === 404
          ? tr('ui.rechargez_le_studio_apres_sa_mise_a_jour_pour_acceder_a_ces_regla')
          : translateKnown(e.message),
      );
      $('.subagent-reload').hidden = false;
    } finally {
      if (turn === generation) {
        busy = false;
        controls();
      }
    }
  }
  async function save(policy = { ...draft }) {
    if (busy || !data || (project && (context.readOnly || !context.online))) return;
    const turn = ++generation;
    const body = { revision: data.revision, policy, ...(project ? { cwd } : {}) };
    busy = true;
    controls();
    error();
    status(() => tr('common.saving'));
    try {
      const saved = await api(endpoint(), { method: 'POST', body });
      if (turn !== generation) return;
      data = saved;
      draft = { ...(project ? data.effective : data.global) };
      // Preserve sparse project role overrides rather than copying inherited roles.
      if (project) draft.roles = { ...data.project?.roles };
      $('.subagent-reload').hidden = true;
      render();
      savedStatus();
      document.dispatchEvent(
        new CustomEvent('subagent-defaults-changed', { detail: { source: root, cwd: project ? cwd : null } }),
      );
      if (!project) toast(() => tr('ui.reglages_des_sous_agents_enregistres'));
    } catch (e) {
      if (turn !== generation) return;
      status(() => tr('ui.modification_non_enregistree'));
      if (project) $('.subagent-scope').value = data.project === null ? 'global' : 'project';
      error(translateKnown(e.message));
      $('.subagent-reload').hidden = false;
    } finally {
      if (turn === generation) {
        busy = false;
        controls();
      }
    }
  }
  modelButton.onclick = () => {
    render();
    const turn = generation;
    openModelPicker({
      button: modelButton,
      value: draft.model,
      get title() {
        return tr('ui.modele_des_sous_agents_2');
      },
      get defaultLabel() {
        return tr('ui.defaut_du_moteur');
      },
      get defaultDetail() {
        return tr('ui.modele_natif_sinon_parent');
      },
      onSelect(model) {
        if (turn !== generation || busy || !data) return;
        draft.model = model;
        render(false);
        if (project) void save();
      },
    });
  };
  thinkingSelect.onchange = () => {
    draft.thinking = thinkingSelect.value;
    if (project) void save();
  };
  if (project)
    $('.subagent-scope').onchange = () => {
      void save($('.subagent-scope').value === 'global' ? null : { ...draft });
    };
  $('.subagent-form').onsubmit = (event) => {
    event.preventDefault();
    void save();
  };
  $('.subagent-reload').onclick = () => void load();
  function update(next = context) {
    context = next;
    if (!project) return;
    const nextCwd = context.enabled ? context.cwd || '' : '';
    if (cwd !== nextCwd) {
      generation++;
      cwd = nextCwd;
      data = null;
      busy = false;
      needsLoad = true;
      error();
      draft = { model: '', thinking: '' };
      render();
    }
    root.hidden = !cwd;
    controls();
    if (cwd && context.active && context.online && needsLoad && !busy) void load();
  }
  const onDefaultsChanged = (event) => {
    if (!project || event.detail.source === root || (event.detail.cwd && event.detail.cwd !== cwd)) return;
    needsLoad = true;
    update();
  };
  document.addEventListener('subagent-defaults-changed', onDefaultsChanged);
  const stopLanguage = onLanguageChange(() => {
    if (!root.isConnected) return;
    render();
    if (data && !busy) savedStatus();
  });
  render();
  return {
    open: load,
    update,
    destroy() {
      generation++;
      document.removeEventListener('subagent-defaults-changed', onDefaultsChanged);
      try {
        stopLanguage?.();
      } catch {}
    },
  };
}
