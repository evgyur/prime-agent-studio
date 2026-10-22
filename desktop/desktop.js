const messages = {
  fr: {
    optionsHeading: 'Options',
    setupFreshEyebrow: 'Première configuration',
    setupFreshTitle: 'Préparons votre Studio',
    setupFreshNote:
      'Le Studio a besoin de quelques composants pour exécuter vos agents. Ils sont téléchargés depuis leurs sources officielles, vérifiés, puis installés pour votre compte Windows. Comptez quelques minutes.',
    setupRepairEyebrow: 'Réparation',
    setupRepairTitle: 'Quelques composants sont à remettre en état',
    setupRepairNote:
      'Certains composants manquent ou ne correspondent pas à cette version du Studio. La réparation télécharge uniquement ce qui est nécessaire. Vos projets et conversations ne sont pas modifiés.',
    setupRunningEyebrow: 'Installation en cours',
    setupRunningTitle: 'Installation des composants',
    setupRunningNote:
      'Vous pouvez laisser cette fenêtre ouverte. Le Studio s’ouvrira automatiquement à la fin.',
    setupRunningNoteManual: 'Vous pouvez laisser cette fenêtre ouverte pendant l’installation.',
    setupFailedEyebrow: 'Installation interrompue',
    setupFailedTitle: 'L’installation s’est arrêtée',
    setupFailedNote:
      'Les éléments déjà vérifiés sont conservés. Corrigez le problème indiqué ci-dessous, puis réessayez : seule la suite sera téléchargée.',
    setupStartingEyebrow: 'Presque terminé',
    setupStartingTitle: 'Ouverture du Studio',
    setupStartingNote: 'Les composants sont prêts. Le Studio démarre pour la première fois.',
    setupInstall: 'Installer les composants',
    setupRetry: 'Réessayer',
    setupStepsHeading: 'Progression',
    setupStep: 'Étape {n} sur {total}',
    setupDone: 'Terminé',
    setupSkipped: 'Déjà prêt',
    setupFailed: 'Échec',
    setupSteps: {
      download: 'Télécharger Prime Agent',
      engine: 'Installer le moteur et ses dépendances',
      uv: 'Télécharger uv',
      python: 'Préparer Python et les skills',
      check: 'Vérifier l’installation',
      start: 'Démarrer le Studio',
    },
    setupHints: {
      download: 'Archives officielles, empreinte vérifiée avant installation.',
      engine: 'Installation des paquets npm. Étape la plus longue : souvent plusieurs minutes.',
      uv: 'Gestionnaire d’environnements Python.',
      python: 'Création de l’environnement Python et installation des skills. Peut prendre plusieurs minutes.',
      check: 'Tests rapides du moteur, de Python et du shell.',
      start: 'Première ouverture : copie des fichiers du Studio puis démarrage du serveur.',
    },
    componentRoles: {
      engine: 'Moteur des agents',
      npm: 'Gestionnaire de paquets privé',
      uv: 'Gestionnaire Python',
      python: 'Exécution des skills',
      bash: 'Commandes shell · installé séparément',
      node: 'Exécution du Studio',
    },
    componentTodo: {
      missing: 'À installer',
      pending: 'Installé avec le moteur',
      error: 'À réparer',
      ready: 'Prêt',
      not_required: 'Non nécessaire',
    },
    componentsHeading: 'Composants du Studio',
    componentsDetails: 'Détails',
    componentsHideDetails: 'Masquer les détails',
    componentsNote:
      'Cette version de Studio utilise Prime Agent 0.9.8. Le bouton télécharge les composants manquants ou la version requise du moteur, npm privé, uv et Python 3.11 si nécessaire. Une connexion Internet est nécessaire. Git Bash doit être installé séparément pour les commandes shell.',
    componentsInstall: 'Réparer Studio',
    componentsActivationFailed:
      'Les composants sont prêts, mais le redémarrage a échoué. Réessayez Redémarrer maintenant ; aucun téléchargement supplémentaire n’est nécessaire.',
    componentsValidation:
      'La validation du composant a échoué. Vérifiez les détails et les journaux avant de réessayer.',
    componentsServerMismatch:
      'Le serveur utilise encore une autre version. Les composants sont conservés ; réessayez Redémarrer maintenant.',
    componentsPort: 'Le port est occupé par un autre service. Libérez-le sans arrêter les agents du Studio.',
    updateGuideTitle: 'Terminer la mise à jour du Studio',
    updateGuideNote:
      'La nouvelle version de Studio est installée, mais son serveur local doit encore être redémarré. Le moteur Prime Agent peut rester à la même version : réparez les composants seulement si besoin. Les agents en cours ne seront pas interrompus sans confirmation.',
    componentsDiagnose: 'Vérifier à nouveau',
    componentsExisting: 'Choisir une installation existante',
    componentsExistingNote:
      'Sélectionnez la racine du paquet Prime Agent (avec package.json), uv.exe ou python.exe. Les chemins définis dans les variables d’environnement restent prioritaires.',
    componentsLater: 'Plus tard : ouvrir le Studio',
    componentsReady: 'Tous les composants sont prêts.',
    componentsBusy: 'Une préparation est déjà en cours. Réessayez après sa fin.',
    componentsFailed: 'La préparation a échoué. Réessayez ; les composants déjà validés sont conservés.',
    componentsExplicit:
      'Le chemin explicitement configuré est invalide ou incompatible. Corrigez la variable d’environnement ou choisissez une autre installation.',
    componentsBash:
      'Git Bash est requis pour les commandes shell. Installez Git pour Windows, ou configurez shellPath dans les réglages Prime Agent, puis vérifiez à nouveau.',
    componentsUnsupported:
      'Cette préparation nécessite Windows x64 et le Node compatible fourni avec Studio.',
    componentsChecksum:
      'L’intégrité ou la structure du téléchargement est invalide. Aucun composant altéré n’est activé.',
    componentsCancelled: 'Préparation annulée. Vous pouvez réessayer.',
    componentsLogPath: 'Journal de préparation : ',
    componentsEngineVersion:
      'Cette version de Studio nécessite Prime Agent 0.9.8 avec ses modules et ressources complets. Installez la version proposée, ou choisissez un paquet compatible.',
    componentsNetwork: 'Le téléchargement a échoué. Vérifiez la connexion réseau et réessayez.',
    componentsDisk:
      'L’espace disque est insuffisant. Libérez de l’espace dans le dossier de données du Studio, puis réessayez.',
    componentsWrite:
      'Écriture refusée dans le dossier de préparation. Vérifiez ses autorisations, puis réessayez.',
    componentStates: {
      ready: 'Validé',
      missing: 'Manquant',
      error: 'À configurer',
      pending: 'À vérifier après le moteur',
      not_required: 'Non nécessaire',
    },
    componentStages: {
      download: 'Téléchargement',
      verify: 'Vérification de l’empreinte',
      install: 'Installation',
      dependencies: 'Installation des dépendances',
      python: 'Préparation de Python et des skills',
      validation: 'Validation des intégrations',
      opening: 'Mise en route dans le serveur',
      server_update_pending: 'Ancien serveur conservé jusqu’au redémarrage',
      error: 'Échec',
    },
    serverHeading: 'Serveur du Studio',
    serverVersion: 'Version active : {version}',
    serverStopped: 'Le serveur est arrêté.',
    serverIdle: 'Aucune exécution en cours.',
    serverBusy: 'Des agents travaillent. Le redémarrage demandera confirmation.',
    serverUnmanaged:
      'L’identité du serveur n’a pas pu être vérifiée. Aucun processus ne sera arrêté. Consultez les détails et réessayez la vérification.',
    restart: 'Redémarrer maintenant',
    restarting: 'Redémarrage du serveur…',
    restarted: 'Le serveur utilise maintenant la version installée.',
    restartFailed: 'Impossible de redémarrer le serveur. Réessayez ou consultez les journaux.',
    restartTitle: 'Redémarrer malgré les agents en cours ?',
    restartNote:
      'Le redémarrage peut interrompre les agents et déconnectera temporairement vos appareils. Vos projets et l’historique enregistré seront conservés.',
    restartCancel: 'Annuler',
    restartProceed: 'Redémarrer quand même',
    operationHeading: 'Opération en cours',
    operationCancel: 'Annuler l’opération',
    backStudio: 'Retour au Studio',
    quitTitle: 'Quitter le Studio ?',
    quitNote: 'Le serveur sera arrêté avant de fermer. Les agents en cours peuvent être interrompus.',
    quitCancel: 'Annuler',
    quitProceed: 'Arrêter et quitter',
    repairDone: 'Les composants sont prêts. Redémarrez maintenant pour les utiliser.',
    studioRestart:
      'Les composants sont déjà prêts. Redémarrez le serveur Studio pour terminer la mise à jour de l’application.',
    autostartUnavailable: 'Le réglage de démarrage Windows ne peut pas être lu. Il n’a pas été modifié.',
    noOperation: 'Aucune opération en cours.',
    eyebrow: 'VOTRE APPLICATION DE BUREAU',
    title: 'Votre espace de travail, prêt à vous suivre.',
    description:
      'Retrouvez vos projets et vos agents dans une fenêtre dédiée. Le Studio démarre pour vous, en arrière-plan.',
    startup: 'Démarrer avec Windows',
    startupNote: 'Disponible dès votre connexion, sans ouvrir de fenêtre.',
    import: 'Reprendre une installation existante',
    importNote: 'Conservez vos projets, pièces jointes et accès distants.',
    imported: 'Les données de cette application sont déjà initialisées.',
    start: 'Ouvrir le Studio',
    footer: 'Fermer la fenêtre laisse les agents travailler sur ce PC.',
    progress: 'Préparation du Studio…',
    retry: 'Réessayer',
    logs: 'Ouvrir les journaux',
    settingsTitle: 'Démarrage et récupération.',
    settingsNote: 'Accès de secours lorsque le Studio est arrêté ou utilise encore une ancienne version.',
    connectingTitle: 'Votre espace se prépare.',
    connectingNote: 'Nous retrouvons le serveur actif ou le démarrons pour vous.',
    connectingProbe: 'Connexion au serveur…',
    startingServer: 'Démarrage du serveur…',
    checkingComponents: 'Vérification des composants…',
    failure: 'Le Studio n’a pas pu démarrer.',
    noBridge: 'Ouvrez cette page dans l’application Prime Agent Studio.',
    selected: 'Installation sélectionnée : ',
    autostartError: 'Le démarrage avec Windows n’a pas pu être modifié.',
    updates: 'Mises à jour',
    updateIdle: 'Recherchez les nouvelles versions publiées sur GitHub.',
    updateCheck: 'Vérifier les mises à jour',
    updateChecking: 'Recherche d’une nouvelle version…',
    updateCurrent: 'Vous utilisez la dernière version publiée.',
    updateAvailable: 'La version {version} est disponible.',
    updateInstall: 'Mettre à jour Studio',
    updateNotes: 'Nouveautés de cette version',
    updateImpact:
      'L’application se relancera. Le redémarrage optionnel du serveur est automatique s’il est libre ; sinon, une confirmation sera nécessaire.',
    updateDownloading: 'Téléchargement',
    updateVerifying: 'Vérification de la signature…',
    updateInstalling: 'Installation et relance de l’application…',
    updateCheckFailed:
      'Impossible de consulter les mises à jour. Vérifiez votre connexion ou réessayez plus tard.',
    updateDownloadFailed:
      'Le téléchargement ou sa signature n’a pas pu être validé. Aucune mise à jour installée.',
    updateInstallFailed: 'L’installation n’a pas pu démarrer. Vous pouvez réessayer.',
  },
  en: {
    optionsHeading: 'Options',
    setupFreshEyebrow: 'First-time setup',
    setupFreshTitle: 'Let’s set up your Studio',
    setupFreshNote:
      'Studio needs a few components to run your agents. They are downloaded from their official sources, verified, then installed for your Windows account. It takes a few minutes.',
    setupRepairEyebrow: 'Repair',
    setupRepairTitle: 'Some components need a repair',
    setupRepairNote:
      'Some components are missing or do not match this Studio version. Repair downloads only what is needed. Your projects and conversations are not changed.',
    setupRunningEyebrow: 'Setup in progress',
    setupRunningTitle: 'Installing components',
    setupRunningNote: 'You can leave this window open. Studio opens automatically when setup is done.',
    setupRunningNoteManual: 'You can leave this window open during setup.',
    setupFailedEyebrow: 'Setup interrupted',
    setupFailedTitle: 'Setup stopped',
    setupFailedNote:
      'Components already verified are kept. Fix the problem shown below, then try again: only the remaining steps are downloaded.',
    setupStartingEyebrow: 'Almost done',
    setupStartingTitle: 'Opening Studio',
    setupStartingNote: 'Components are ready. Studio is starting for the first time.',
    setupInstall: 'Install components',
    setupRetry: 'Try again',
    setupStepsHeading: 'Progress',
    setupStep: 'Step {n} of {total}',
    setupDone: 'Done',
    setupSkipped: 'Already ready',
    setupFailed: 'Failed',
    setupSteps: {
      download: 'Download Prime Agent',
      engine: 'Install the engine and its dependencies',
      uv: 'Download uv',
      python: 'Set up Python and skills',
      check: 'Check the installation',
      start: 'Start Studio',
    },
    setupHints: {
      download: 'Official archives, checksum verified before install.',
      engine: 'Installing npm packages. Longest step: often several minutes.',
      uv: 'Python environment manager.',
      python: 'Creating the Python environment and installing skills. May take several minutes.',
      check: 'Quick checks of the engine, Python and the shell.',
      start: 'First launch: copying Studio files, then starting the server.',
    },
    componentRoles: {
      engine: 'Agent engine',
      npm: 'Private package manager',
      uv: 'Python manager',
      python: 'Runs skills',
      bash: 'Shell commands · installed separately',
      node: 'Runs Studio',
    },
    componentTodo: {
      missing: 'To install',
      pending: 'Installed with the engine',
      error: 'Needs repair',
      ready: 'Ready',
      not_required: 'Not required',
    },
    componentsHeading: 'Studio components',
    componentsDetails: 'Details',
    componentsHideDetails: 'Hide details',
    componentsNote:
      'This Studio version uses Prime Agent 0.9.8. The button downloads missing components or the required engine version, private npm, uv and Python 3.11 when needed. An Internet connection is required. Git Bash must be installed separately for shell commands.',
    componentsInstall: 'Repair Studio',
    componentsActivationFailed:
      'Components are ready, but restart failed. Retry Restart now; no further download is needed.',
    componentsValidation: 'Component validation failed. Check the details and logs before trying again.',
    componentsServerMismatch:
      'The server is still using another version. Components are kept; retry Restart now.',
    componentsPort: 'Another service is using the port. Free it without stopping Studio agents.',
    updateGuideTitle: 'Finish the Studio update',
    updateGuideNote:
      'The new Studio version is installed, but its local server still needs to restart. The Prime Agent engine may stay on the same version; repair components only if needed. Running agents will not be interrupted without confirmation.',
    componentsDiagnose: 'Check again',
    componentsExisting: 'Choose an existing installation',
    componentsExistingNote:
      'Select the Prime Agent package root (with package.json), uv.exe or python.exe. Environment variable paths take precedence.',
    componentsLater: 'Later: open Studio',
    componentsReady: 'All components are ready.',
    componentsBusy: 'Another preparation is in progress. Try again when it finishes.',
    componentsFailed: 'Preparation failed. Try again; validated components are preserved.',
    componentsExplicit:
      'The explicitly configured path is invalid or incompatible. Correct the environment variable or choose another installation.',
    componentsBash:
      'Git Bash is required for shell commands. Install Git for Windows, or configure shellPath in Prime Agent settings, then check again.',
    componentsUnsupported: 'Setup requires Windows x64 and the compatible Node supplied with Studio.',
    componentsChecksum:
      'The download integrity or archive structure is invalid. No altered component is activated.',
    componentsCancelled: 'Preparation cancelled. You can try again.',
    componentsLogPath: 'Setup log: ',
    componentsEngineVersion:
      'This Studio version requires Prime Agent 0.9.8 with complete modules and resources. Install the proposed version, or select a compatible package.',
    componentsNetwork: 'Download failed. Check your network connection and try again.',
    componentsDisk:
      'There is not enough disk space. Free space in the Studio data directory, then try again.',
    componentsWrite: 'Writing to the setup directory was denied. Check its permissions, then try again.',
    componentStates: {
      ready: 'Validated',
      missing: 'Missing',
      error: 'Needs setup',
      pending: 'Check after engine setup',
      not_required: 'Not needed',
    },
    componentStages: {
      download: 'Downloading',
      verify: 'Verifying checksum',
      install: 'Installing',
      dependencies: 'Installing dependencies',
      python: 'Preparing Python and skills',
      validation: 'Validating integrations',
      opening: 'Starting in the server',
      server_update_pending: 'Previous server kept until restart',
      error: 'Failed',
    },
    serverHeading: 'Studio server',
    serverVersion: 'Running version: {version}',
    serverStopped: 'The server is stopped.',
    serverIdle: 'No active runs.',
    serverBusy: 'Agents are working. Restarting will require confirmation.',
    serverUnmanaged:
      'The server identity could not be verified. No process will be stopped. Check the details and retry the check.',
    restart: 'Restart now',
    restarting: 'Restarting the server…',
    restarted: 'The server is now using the installed version.',
    restartFailed: 'Could not restart the server. Try again or check the logs.',
    restartTitle: 'Restart while agents are running?',
    restartNote:
      'Restarting may interrupt agents and will temporarily disconnect your devices. Your projects and saved history will be preserved.',
    restartCancel: 'Cancel',
    restartProceed: 'Restart anyway',
    operationHeading: 'Current operation',
    operationCancel: 'Cancel operation',
    backStudio: 'Back to Studio',
    quitTitle: 'Quit Studio?',
    quitNote: 'The server will be stopped before closing. Running agents may be interrupted.',
    quitCancel: 'Cancel',
    quitProceed: 'Stop and quit',
    repairDone: 'Components are ready. Restart now to use them.',
    studioRestart: 'Components are already ready. Restart the Studio server to finish the app update.',
    autostartUnavailable: 'The Windows startup setting could not be read. It has not been changed.',
    noOperation: 'No operation running.',
    eyebrow: 'YOUR DESKTOP APPLICATION',
    title: 'Your workspace, ready when you are.',
    description: 'Your projects and agents in a dedicated window. Studio starts for you, in the background.',
    startup: 'Start with Windows',
    startupNote: 'Ready when you sign in, without opening a window.',
    import: 'Use an existing installation',
    importNote: 'Keep your projects, attachments and remote access.',
    imported: 'This application’s data has already been initialized.',
    start: 'Open Studio',
    footer: 'Closing the window leaves agents working on this PC.',
    progress: 'Preparing Studio…',
    retry: 'Try again',
    logs: 'Open logs',
    settingsTitle: 'Startup and recovery.',
    settingsNote: 'Recovery controls when Studio is stopped or still running an older version.',
    connectingTitle: 'Preparing your workspace.',
    connectingNote: 'We are finding the running server or starting it for you.',
    connectingProbe: 'Connecting to server…',
    startingServer: 'Starting server…',
    checkingComponents: 'Checking components…',
    failure: 'Studio could not start.',
    noBridge: 'Open this page in the Prime Agent Studio application.',
    selected: 'Selected installation: ',
    autostartError: 'Could not change the start with Windows setting.',
    updates: 'Updates',
    updateIdle: 'Check for new versions published on GitHub.',
    updateCheck: 'Check for updates',
    updateChecking: 'Checking for a new version…',
    updateCurrent: 'You are using the latest published version.',
    updateAvailable: 'Version {version} is available.',
    updateInstall: 'Update Studio',
    updateNotes: 'What’s new',
    updateImpact:
      'The app will relaunch. The optional server restart is automatic when idle; otherwise, confirmation will be required.',
    updateDownloading: 'Downloading',
    updateVerifying: 'Verifying the signature…',
    updateInstalling: 'Installing and restarting the app…',
    updateCheckFailed: 'Could not check for updates. Check your connection or try again later.',
    updateDownloadFailed: 'The download or its signature could not be verified. No update was installed.',
    updateInstallFailed: 'The installer could not start. You can try again.',
  },
};
const language = navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en',
  t = messages[language],
  $ = (id) => document.getElementById(id);
document.documentElement.lang = language;
// Quit handshake flag: native request_quit_confirmation only dispatches
// studio:quit-request when this is true, otherwise it navigates here itself.
// An old server page without this flag falls back to the local quit shell.
window.__PRIME_STUDIO_QUIT_READY__ = true;
const settings = new URLSearchParams(location.search).has('settings');
const backgroundParam = new URLSearchParams(location.search).has('background');
document.body.classList.toggle('app-settings', settings);
// Boot class hides launcher controls until explicit settings/needs-config.
// Main window shows minimal connecting state first, never settings visually.
document.body.classList.add('boot');
document.body.classList.add('boot-connecting');
for (const [id, key] of Object.entries({
  'update-cancel': 'operationCancel',
  'back-studio': 'backStudio',
  'quit-confirm-title': 'quitTitle',
  'quit-confirm-note': 'quitNote',
  'quit-cancel': 'quitCancel',
  'quit-proceed': 'quitProceed',
  eyebrow: 'eyebrow',
  title: settings ? 'settingsTitle' : 'title',
  description: settings ? 'settingsNote' : 'description',
  'startup-label': 'startup',
  'components-heading': 'componentsHeading',
  'options-heading': 'optionsHeading',
  'components-note': 'componentsNote',
  'components-install': 'componentsInstall',
  'components-diagnose': 'componentsDiagnose',
  'components-existing': 'componentsExisting',
  'components-existing-note': 'componentsExistingNote',
  'components-cancel': 'restartCancel',
  'startup-note': 'startupNote',
  import: 'import',
  'import-note': 'importNote',
  start: 'start',
  footer: 'footer',
  'progress-text': 'progress',
  logs: 'logs',
  'update-heading': 'updates',
  'update-status': 'updateIdle',
  'update-check': 'updateCheck',
  'update-install': 'updateInstall',
  'update-notes-label': 'updateNotes',
  'update-impact': 'updateImpact',
  'server-heading': 'serverHeading',
  'server-restart': 'restart',
  'restart-confirm-title': 'restartTitle',
  'restart-confirm-note': 'restartNote',
  'restart-cancel': 'restartCancel',
  'restart-proceed': 'restartProceed',
}))
  $(id).textContent = t[key];
const invoke = window.__TAURI__?.core?.invoke;
let componentsBusy = false;
let latestComponents;
let updatePending = false;
// Migration notice removed: single clear flow (Check / Update or Repair / Restart + Back).

// Warm-first helpers: connecting-first UI, never silent frozen.
function isComponentsRequired(error) {
  return String(error || '').includes('components_required');
}
function setPhase(text) {
  // The guided setup has its own status line.
  if (text && !setup) {
    $('progress').hidden = false;
    $('progress-text').textContent = text;
  }
}
function showConnecting(title, note, phase) {
  document.body.classList.add('boot');
  document.body.classList.add('boot-connecting');
  document.body.classList.remove('boot-ready');
  $('choices').hidden = true;
  $('components').hidden = true;
  if ($('updates') && !settings) $('updates').hidden = true;
  if (title) $('title').textContent = title;
  if (note) $('description').textContent = note;
  if (phase) setPhase(phase);
  else $('progress').hidden = false;
  $('start').disabled = true;
  showError('');
}
function showLauncher() {
  document.body.classList.remove('boot-connecting');
  document.body.classList.add('boot-ready');
  document.body.classList.remove('boot');
  $('choices').hidden = false;
  $('progress').hidden = true;
  $('start').disabled = false;
}
const componentNames = {
  engine: 'Prime Agent',
  uv: 'uv',
  python: 'Python',
  node: 'Node (Studio)',
  npm: 'npm',
  bash: 'Git Bash',
  studio: 'Studio',
};
function componentError(code) {
  if (code === 'engine_incompatible') return t.componentsEngineVersion;
  if (code === 'download_failed') return t.componentsNetwork;
  if (code === 'disk_full') return t.componentsDisk;
  if (code === 'write_denied') return t.componentsWrite;
  if (code === 'explicit_invalid') return t.componentsExplicit;
  if (code === 'bash_missing') return t.componentsBash;
  if (['architecture_unsupported', 'node_incompatible'].includes(code)) return t.componentsUnsupported;
  if (['checksum_mismatch', 'checksum_missing', 'unsafe_archive'].includes(code)) return t.componentsChecksum;
  if (code === 'cancelled') return t.componentsCancelled;
  if (['setup_busy', 'update_busy'].includes(code)) return t.componentsBusy;
  if (['server_validation_failed', 'server_version_mismatch'].includes(code))
    return t.componentsServerMismatch;
  if (code === 'server_not_managed') return t.serverUnmanaged;
  if (code === 'server_port_occupied') return t.componentsPort;
  if (code === 'validation_failed') return t.componentsValidation;
  if (['server_activation_failed', 'server_status_failed', 'server_restart_failed'].includes(code))
    return t.componentsActivationFailed;
  return t.componentsFailed;
}
function renderComponents(result) {
  if (!result || result.cancelled) {
    latestComponents = undefined;
    return;
  }
  if (result.failure) {
    latestComponents = undefined;
    $('components-status').textContent =
      `${componentNames[result.failure.component] || ''} : ${componentError(result.failure.error)}${
        typeof result.failure.logPath === 'string' ? ` ${t.componentsLogPath}${result.failure.logPath}` : ''
      }`;
    return;
  }
  latestComponents = result;
  if (!setup) renderComponentRows(result);
  $('components-detail-list').replaceChildren();
  for (const [key, info] of Object.entries(result.components || {})) {
    const row = document.createElement('li');
    row.textContent = `${componentNames[key] || key}, ${t.componentStates[info.status] || info.status}${info.version ? ` · ${info.version}` : ''}`;
    if (info.path) {
      const path = document.createElement('small');
      path.textContent = info.path;
      row.append(path);
    }
    if (info.provenance) {
      const source = document.createElement('small');
      source.textContent = info.provenance;
      row.append(source);
    }
    if (info.error && info.error !== 'missing') {
      const error = document.createElement('small');
      error.textContent = componentError(info.explicit ? 'explicit_invalid' : info.error);
      row.append(error);
    }
    $('components-detail-list').append(row);
  }
  $('components-status').textContent =
    result.activation === 'failed'
      ? `${t.componentsActivationFailed} ${componentError(result.activationError)}`
      : result.ready && result.serverUpdatePending
        ? t.studioRestart
        : result.ready &&
            result.server?.running !== false &&
            (result.needsRestart || result.activation === 'deferred')
          ? t.repairDone
          : result.ready
            ? t.componentsReady
            : Object.entries(result.components || {})
                .filter(([, info]) => info.error && info.error !== 'missing')
                .map(
                  ([key, info]) =>
                    `${componentNames[key] || key} : ${componentError(info.explicit ? 'explicit_invalid' : info.error)}`,
                )
                .join(' ');
  $('components-install').hidden = result.ready;
  // Single restart rule: no second activation button. Repair (prepare) then the
  // one server Restart now below. Hide apply to avoid double activation.
  $('components-actions').hidden = result.ready;
  $('start').textContent = updatePending || !result.ready ? t.componentsLater : t.start;
  // One obvious primary action: "Later" stays a quiet text link while setup is due.
  $('start').className = updatePending || !result.ready ? 'text-button' : 'primary';
  $('components-install').textContent = isFreshInstall(result) ? t.setupInstall : t.componentsInstall;
  if (result.activation === 'failed') $('logs').hidden = false;
}
$('components-toggle').textContent = t.componentsDetails;
$('components-toggle').onclick = () => {
  const expanded = $('components-details').hidden;
  $('components-details').hidden = !expanded;
  $('components-toggle').setAttribute('aria-expanded', String(expanded));
  $('components-toggle').textContent = expanded ? t.componentsHideDetails : t.componentsDetails;
};
async function componentsAction(action, component) {
  if (componentsBusy) return;
  componentsBusy = true;
  const installing = ['install', 'prepare'].includes(action);
  // First launch with a stopped server: the Studio can open itself right
  // after setup. A running server is never restarted implicitly.
  const autoOpen =
    installing && !settings && !updatePending && latestComponents?.server?.running === false;
  const before = latestComponents;
  // Concrete phase immediately, never silent frozen window.
  $('components').hidden = false;
  document.body.classList.remove('boot-connecting');
  document.body.classList.add('boot-ready');
  document.body.classList.remove('boot');
  if (installing) {
    setupBegin(autoOpen);
    $('components-install').hidden = true;
  } else setPhase(t.checkingComponents);
  $('components-status').textContent = installing ? '' : t.checkingComponents;
  for (const el of $('components').querySelectorAll('button')) el.disabled = true;
  $('components-cancel').hidden = !installing;
  $('components-cancel').disabled = false;
  $('start').disabled = true;
  let result;
  try {
    result = await invoke('desktop_components', { action, component: component || null });
    renderComponents(result);
    if (installing) {
      if (result?.ready) {
        setupAdvance('check');
        setup.states.check = 'done';
        if (autoOpen && !result.needsRestart) {
          setupAdvance('start');
          $('components-actions').hidden = true;
          return result;
        }
        setupEnd(true);
      } else {
        // A failed run keeps the last diagnose, so "Later" still opens Studio.
        if (!result?.ready && !latestComponents) latestComponents = before;
        if (result?.cancelled || result?.failure?.error === 'cancelled') setupEnd(true);
        else setupFail();
      }
    }
    // Never auto restart an active agent. Prepare only installs/validates;
    // the user triggers one explicit Restart now when idle (with force confirm).
    return result;
  } catch (error) {
    latestComponents = undefined;
    const message = isComponentsRequired(error) ? t.checkingComponents : componentError(String(error));
    $('components-status').textContent = message;
    if (installing) setupFail();
    else setPhase(message);
  } finally {
    componentsBusy = false;
    for (const el of $('components').querySelectorAll('button')) el.disabled = false;
    $('components-cancel').hidden = true;
    $('start').disabled = false;
    if (installing && setup?.states.start === 'active') {
      // Hand over to the normal start path; the step list stays visible
      // until the native shell navigates to Studio.
      // start() reports its own failure (title, error, Retry); only mark the step.
      void start({ rethrow: true }).catch(() => {
        if (!setup) return;
        setup.states.start = 'failed';
        clearInterval(setup.timer);
        setup.timer = null;
        $('start').hidden = false;
        $('logs').hidden = false;
        renderSetup();
      });
    }
  }
}

// Guided setup: one ordered step list instead of a single status line.
// Progress events only move forward, so the final diagnose (which re-emits
// earlier component stages) never sends the view back. Each active step shows
// a live timer and a hint, so long silent work (npm install, Python) still
// reads as progress.
const SETUP_STEPS = ['download', 'engine', 'uv', 'python', 'check', 'start'];
let setup = null;
function setupPhase(payload) {
  const { component, stage } = payload || {};
  if (stage === 'opening') return 'start';
  if (component === 'uv' && ['download', 'verify', 'install'].includes(stage)) return 'uv';
  if (['npm', 'engine'].includes(component) && ['download', 'verify'].includes(stage)) return 'download';
  if (component === 'npm' && stage === 'install') return 'download';
  if (component === 'engine' && ['install', 'dependencies'].includes(stage)) return 'engine';
  if (stage === 'python') return 'python';
  if (stage === 'validation') return 'check';
  return null;
}
function formatStepTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}
const formatSize = (bytes) =>
  bytes < 1048576
    ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(language)} ${language === 'fr' ? 'Ko' : 'KB'}`
    : `${(bytes / 1048576).toLocaleString(language, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${language === 'fr' ? 'Mo' : 'MB'}`;
function setIntro(kind) {
  const prefix = { fresh: 'setupFresh', repair: 'setupRepair', running: 'setupRunning', failed: 'setupFailed', starting: 'setupStarting' }[kind];
  if (!prefix) return;
  $('eyebrow').textContent = t[prefix + 'Eyebrow'];
  $('title').textContent = t[prefix + 'Title'];
  $('description').textContent = t[prefix + 'Note'];
}
function isFreshInstall(result) {
  if (!result || result.installedEngine) return false;
  return !Object.entries(result.components || {}).some(
    ([key, info]) => !['bash', 'node'].includes(key) && info.status === 'ready',
  );
}
function setupBegin(autoOpen) {
  clearInterval(setup?.timer);
  const intro = setup?.intro || {
    eyebrow: $('eyebrow').textContent,
    title: $('title').textContent,
    description: $('description').textContent,
  };
  setup = {
    index: -1,
    intro,
    autoOpen,
    touched: {},
    states: Object.fromEntries(SETUP_STEPS.map((id) => [id, 'pending'])),
    stepStartedAt: Date.now(),
    received: undefined,
    total: undefined,
    timer: setInterval(renderSetup, 1000),
  };
  if (!autoOpen) setup.states.start = 'hidden';
  $('components-status').classList.remove('failed');
  setIntro('running');
  if (!autoOpen) $('description').textContent = t.setupRunningNoteManual;
  $('components-heading').textContent = t.setupStepsHeading;
  $('choices').hidden = true;
  $('start').hidden = true;
  $('logs').hidden = true;
  $('progress').hidden = true;
  showError('');
  setupAdvance('download');
}
function setupAdvance(id, payload = {}) {
  if (!setup) return;
  const next = SETUP_STEPS.indexOf(id);
  if (next < setup.index) return;
  if (next > setup.index) {
    for (let i = Math.max(setup.index, 0); i < next; i++) {
      const step = SETUP_STEPS[i];
      // A step that never received an event was already in place.
      if (setup.states[step] === 'active') setup.states[step] = setup.touched?.[step] ? 'done' : 'skipped';
      else if (setup.states[step] === 'pending') setup.states[step] = 'skipped';
      // 'hidden' (no auto open) stays hidden.
    }
    setup.index = next;
    setup.states[id] = 'active';
    if (id === 'start') setIntro('starting');
    setup.stepStartedAt = Date.now();
    setup.received = setup.total = undefined;
  }
  if (payload.component) (setup.touched ||= {})[id] = true;
  if (payload.received !== undefined) {
    setup.received = payload.received;
    setup.total = payload.total;
  } else if (payload.stage && payload.stage !== 'download') setup.received = setup.total = undefined;
  renderSetup();
}
function setupFail() {
  if (!setup) return;
  const step = SETUP_STEPS[Math.max(setup.index, 0)];
  setup.states[step] = 'failed';
  clearInterval(setup.timer);
  setup.timer = null;
  setIntro('failed');
  $('components-status').classList.add('failed');
  $('components-install').textContent = t.setupRetry;
  $('components-actions').hidden = false;
  $('components-install').hidden = false;
  $('start').hidden = false;
  $('logs').hidden = false;
  renderSetup();
}
// restore: put back the intro shown before setup (update guide, settings…).
function setupEnd(restore) {
  if (!setup) return;
  clearInterval(setup.timer);
  const intro = setup.intro;
  setup = null;
  $('setup-meter').hidden = true;
  $('start').hidden = false;
  $('components-heading').textContent = t.componentsHeading;
  if (restore && intro) {
    $('eyebrow').textContent = intro.eyebrow;
    $('title').textContent = intro.title;
    $('description').textContent = intro.description;
  }
  if (latestComponents) renderComponentRows(latestComponents);
  $('components-install').hidden = Boolean(latestComponents?.ready);
}
function renderSetup() {
  if (!setup) return;
  const list = $('components-list');
  list.className = 'setup-list steps';
  list.replaceChildren();
  const active = SETUP_STEPS[setup.index];
  const visible = SETUP_STEPS.filter((id) => setup.states[id] !== 'hidden');
  for (const id of visible) {
    const state = setup.states[id];
    const row = document.createElement('li');
    row.className = 'setup-row';
    row.dataset.state = state;
    if (state === 'active') row.setAttribute('aria-current', 'step');
    const icon = document.createElement('span');
    icon.className = 'setup-icon';
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.className = 'setup-body';
    const label = document.createElement('strong');
    label.textContent = t.setupSteps[id];
    body.append(label);
    if (state === 'active' || state === 'failed') {
      const hint = document.createElement('small');
      hint.textContent =
        state === 'active' && setup.received !== undefined
          ? `${formatSize(setup.received)}${setup.total ? ` / ${formatSize(setup.total)}` : ''}`
          : t.setupHints[id];
      body.append(hint);
    }
    const meta = document.createElement('span');
    meta.className = 'setup-meta';
    meta.textContent =
      state === 'active'
        ? formatStepTime(Date.now() - setup.stepStartedAt)
        : { done: t.setupDone, skipped: t.setupSkipped, failed: t.setupFailed, pending: '' }[state];
    row.append(icon, body, meta);
    list.append(row);
  }
  const meter = $('setup-meter');
  meter.hidden = !active || setup.states[active] !== 'active';
  const determinate = setup.received !== undefined && setup.total > 0;
  meter.classList.toggle('indeterminate', !determinate);
  $('setup-meter-fill').style.width = determinate
    ? `${Math.min(100, Math.round((setup.received / setup.total) * 100))}%`
    : '';
  // Status line changes only with the step (no per-second screen reader noise).
  const label = active
    ? `${t.setupStep.replace('{n}', visible.indexOf(active) + 1).replace('{total}', visible.length)} · ${t.setupSteps[active]}`
    : '';
  if ($('setup-meter-label').textContent !== label) $('setup-meter-label').textContent = label;
}
function renderComponentRows(result) {
  const list = $('components-list');
  list.className = 'setup-list';
  list.replaceChildren();
  for (const [key, info] of Object.entries(result.components || {})) {
    const row = document.createElement('li');
    row.className = 'setup-row';
    row.dataset.state = info.status === 'ready' ? 'done' : info.status === 'error' ? 'failed' : 'todo';
    const icon = document.createElement('span');
    icon.className = 'setup-icon';
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.className = 'setup-body';
    const label = document.createElement('strong');
    label.textContent = `${componentNames[key] || key}${info.version ? ` ${info.version}` : ''}`;
    body.append(label);
    if (t.componentRoles[key]) {
      const role = document.createElement('small');
      role.textContent = t.componentRoles[key];
      body.append(role);
    }
    const meta = document.createElement('span');
    meta.className = 'setup-meta';
    meta.textContent = t.componentTodo[info.status] || t.componentStates[info.status] || info.status;
    row.append(icon, body, meta);
    list.append(row);
  }
}
$('components-install').onclick = () => componentsAction('prepare');
$('components-diagnose').onclick = () => componentsAction('diagnose');
$('components-cancel').onclick = () => invoke('desktop_components_cancel');
$('update-cancel').onclick = async () => {
  try {
    await invoke('desktop_update_cancel');
  } catch {
    try {
      await invoke('desktop_components_cancel');
    } catch {}
  }
  await pollOperationOnce();
};
for (const name of ['engine', 'uv', 'python'])
  $('components-' + name).onclick = () => componentsAction('select', name);
void window.__TAURI__?.event?.listen('components-progress', ({ payload }) => {
  const received =
    payload.received === undefined
      ? ''
      : ` · ${payload.received.toLocaleString(language)} ${language === 'fr' ? 'octets reçus' : 'bytes received'}${payload.total ? ` / ${payload.total.toLocaleString(language)}` : ''}`;
  // Install: the ordered step list carries progress (bytes, timer, hint).
  if (setup) {
    const phase = setupPhase(payload);
    if (phase) setupAdvance(phase, payload);
    return;
  }
  // Detailed diagnose steps (engine/python/shell/uv) plus download progress.
  const text = `${componentNames[payload.component] || payload.component || ''}, ${t.componentStages[payload.stage] || payload.stage || ''}${received}`;
  $('components-status').textContent = text;
  // Mirror diagnose phases in the main connecting line so the window never freezes silently.
  if ($('components') && !$('components').hidden) setPhase(text);
});
// Launcher has no vendor marked/DOMPurify bundle. Escape first, then allow a
// small markdown subset (headings, lists, bold, code, allowlisted links).
// Raw HTML such as <img onerror=...> stays inert text, never an element.
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
function inlineNotes(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\[\]\n]+?)\]\(([^\)\s]+?)\)/g, (m, label, href) => {
    if (!/^(https?:|mailto:|#|\/)/i.test(href)) return label;
    const safe = escapeHtml(href);
    const extra = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${safe}"${extra}>${label}</a>`;
  });
  return out;
}
function renderLauncherNotes(raw) {
  const body = $('update-notes-body');
  body.replaceChildren();
  const lines = String(raw || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let list = null;
  const closeList = () => {
    list = null;
  };
  let fence = null;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (fence) {
        fence = null;
      } else {
        closeList();
        fence = document.createElement('pre');
        const code = document.createElement('code');
        fence.append(code);
        body.append(fence);
      }
      continue;
    }
    if (fence) {
      fence.firstChild.append(document.createTextNode(line + '\n'));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*\S)\s*$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const el = document.createElement(level === 1 ? 'h4' : 'h5');
      el.innerHTML = inlineNotes(heading[2]);
      body.append(el);
      continue;
    }
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
    if (item) {
      if (!list) {
        list = document.createElement('ul');
        body.append(list);
      }
      const li = document.createElement('li');
      li.innerHTML = inlineNotes(item[1]);
      list.append(li);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    const p = document.createElement('p');
    p.innerHTML = inlineNotes(line.trim());
    body.append(p);
  }
}
let updateBusy = false,
  availableVersion;
function updateStatus(message, error = false) {
  $('update-status').textContent = message;
  $('update-status').classList.toggle('failed', error);
}
$('update-check').onclick = async () => {
  if (updateBusy) return;
  updateBusy = true;
  availableVersion = undefined;
  $('update-check').disabled = true;
  $('update-install').hidden = true;
  $('update-notes').hidden = true;
  $('update-impact').hidden = true;
  if ($('update-cancel')) $('update-cancel').hidden = true;
  updateStatus(t.updateChecking);
  try {
    const update = await invoke('desktop_update_check');
    if (update.available) {
      availableVersion = update.version;
      updateStatus(t.updateAvailable.replace('{version}', update.version));
      $('update-install').hidden = false;
      $('update-impact').hidden = false;
      renderLauncherNotes(update.notes || '');
      $('update-notes').hidden = !update.notes;
    } else updateStatus(t.updateCurrent);
  } catch {
    updateStatus(t.updateCheckFailed, true);
  } finally {
    updateBusy = false;
    $('update-check').disabled = false;
  }
};
$('update-install').onclick = async () => {
  if (updateBusy || !availableVersion) return;
  updateBusy = true;
  $('update-check').disabled = true;
  $('update-install').disabled = true;
  $('start').disabled = true;
  $('update-progress').hidden = false;
  $('update-progress').removeAttribute('value');
  updateStatus(t.updateDownloading + '…');
  try {
    const onEvent = new window.__TAURI__.core.Channel();
    onEvent.onmessage = ({ stage, percent }) => {
      if (stage === 'downloading') {
        updateStatus(t.updateDownloading + (percent == null ? '…' : ` · ${percent} %`));
        if (percent != null) $('update-progress').value = percent;
      } else {
        updateStatus(stage === 'verifying' ? t.updateVerifying : t.updateInstalling);
        $('update-progress').removeAttribute('value');
      }
    };
    await invoke('desktop_update_install', {
      version: availableVersion,
      onEvent,
      restartServer: false,
    });
    // Success: no stale busy UI. Installer relaunches the app; clear progress
    // at once so a lingering window never shows a frozen downloading state.
    currentOperation = null;
    if ($('update-cancel')) $('update-cancel').hidden = true;
    $('update-progress').hidden = true;
    $('update-progress').removeAttribute('value');
    updateStatus(t.updateCurrent);
    availableVersion = undefined;
    $('update-install').hidden = true;
    $('update-impact').hidden = true;
    $('update-check').disabled = false;
    $('start').disabled = false;
    updateBusy = false;
    await refreshServer().catch(() => {});
    await pollOperationOnce().catch(() => null);
  } catch (error) {
    updateStatus(error === 'install_failed' ? t.updateInstallFailed : t.updateDownloadFailed, true);
    $('update-progress').hidden = true;
    $('update-check').disabled = false;
    $('update-install').disabled = false;
    $('start').disabled = false;
    updateBusy = false;
  }
};
let restarting = false;
async function refreshServer() {
  const state = await invoke('desktop_update_status');
  $('server-state').textContent = state.running
    ? t.serverVersion.replace('{version}', state.version || '?')
    : t.serverStopped;
  // Control contract: ownership managed|recoverable|unverified|absent, canRestart,
  // restartReason, canStop/stopReason, source, pid/port/instanceId. Recoverable
  // (OS-verified, no owner file) stays restartable; foreign stays protected.
  const canRestart = state.canRestart !== undefined ? state.canRestart : state.managed;
  const restartReason = state.restartReason || (state.managed === false ? 'server_not_managed' : null);
  if (!state.running) {
    $('server-agents').textContent = t.serverStopped;
  } else if (canRestart === false) {
    $('server-agents').textContent =
      restartReason === 'server_port_occupied' ? t.componentsPort : t.serverUnmanaged;
  } else {
    $('server-agents').textContent = state.activeRuns ? t.serverBusy : t.serverIdle;
  }
  $('server-restart').disabled = !canRestart || restarting || updateBusy;
  $('server-restart').textContent = t.restart;
  return state;
}
let currentOperation = null;
function formatBytes(value) {
  if (value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}
function formatElapsed(ms) {
  if (ms == null) return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}
function formatOperation(op) {
  // Shared snapshot, translated progress (bytes/time), never raw codes.
  if (!op) return '';
  const bits = [];
  if (op.kind) bits.push(op.kind);
  if (op.stage && !op.terminal) bits.push(op.stage);
  if (op.percent != null) bits.push(`${op.percent} %`);
  const bytes = formatBytes(op.receivedBytes);
  const total = formatBytes(op.totalBytes);
  if (bytes && total) bits.push(`${bytes} / ${total}`);
  else if (bytes) bits.push(bytes);
  if (op.updatedAt != null && op.startedAt != null) {
    const elapsed = formatElapsed(op.updatedAt - op.startedAt);
    if (elapsed) bits.push(elapsed);
  }
  if (op.detail) bits.push(op.detail);
  if (op.terminal && op.stage === 'done') bits.push(language === 'fr' ? 'termine' : 'done');
  return bits.join(', ');
}
async function pollOperationOnce() {
  try {
    const res = await invoke('desktop_update_operation');
    const op = res?.operation || null;
    currentOperation = op;
    const cancelBtn = $('update-cancel');
    if (!op || op.terminal) {
      if (cancelBtn) cancelBtn.hidden = true;
      return op;
    }
    // Single status line (no duplicate section): show live progress here.
    updateStatus(formatOperation(op));
    if (cancelBtn) {
      cancelBtn.hidden = !op.cancellable;
      cancelBtn.disabled = !op.cancellable;
    }
    return op;
  } catch {
    currentOperation = null;
    return null;
  }
}
function startOperationPoll() {
  if (window.__operationPoll) return;
  window.__operationPoll = setInterval(() => {
    if ($('updates') && !$('updates').hidden) void pollOperationOnce();
  }, 1000);
}
let quitting = false;
function showQuitDialog(prefill = {}) {
  const dialog = $('quit-confirm');
  if (!dialog) return;
  if (prefill.detail) {
    $('quit-confirm-detail').textContent = prefill.detail;
    $('quit-confirm-detail').hidden = false;
  } else {
    $('quit-confirm-detail').hidden = true;
  }
  try {
    if (!dialog.open) dialog.showModal();
  } catch {
    dialog.setAttribute('open', '');
  }
  $('quit-cancel').focus();
}
async function requestQuitFlow() {
  if (quitting) return;
  quitting = true;
  try {
    let snapshot = null;
    try {
      snapshot = await invoke('desktop_update_status');
    } catch {}
    const op = await pollOperationOnce().catch(() => null);
    const activeRuns = snapshot?.activeRuns || 0;
    const needsConfirm = activeRuns > 0 || (op && !op.terminal);
    if (!needsConfirm) {
      // Idle: stop direct after snapshot, exit only on confirmed stop.
      try {
        const res = await invoke('desktop_quit', { force: false, cancelCurrent: false });
        if (res && (res.stopped === true || res.reason === 'already-stopped')) return;
      } catch {}
      showQuitDialog();
      return;
    }
    const detail = activeRuns ? t.serverBusy : `${op?.kind || ''}, ${op?.stage || ''}`;
    showQuitDialog({ detail });
  } finally {
    quitting = false;
  }
}
if ($('quit-cancel'))
  $('quit-cancel').onclick = () => {
    const d = $('quit-confirm');
    if (d && d.open) d.close('cancel');
    if (d) d.removeAttribute('open');
  };
if ($('quit-proceed'))
  $('quit-proceed').onclick = async () => {
    $('quit-proceed').disabled = true;
    try {
      const snapshot = await invoke('desktop_update_status').catch(() => null);
      const op = currentOperation;
      const force = Boolean(snapshot && snapshot.activeRuns);
      // Confirmation before cancel: quit with cancelCurrent only after explicit proceed.
      const cancelCurrent = Boolean(op && op.cancellable);
      const res = await invoke('desktop_quit', { force, cancelCurrent });
      if (res && (res.stopped === true || res.reason === 'already-stopped')) return;
      $('quit-confirm-note').textContent = t.restartFailed;
    } catch (error) {
      $('quit-confirm-note').textContent =
        String(error) === 'update_busy' ? t.componentsBusy : t.restartFailed;
    } finally {
      $('quit-proceed').disabled = false;
    }
  };
window.addEventListener('studio:quit-request', () => requestQuitFlow());
if ($('back-studio'))
  $('back-studio').onclick = async () => {
    try {
      await start({ allowUnconfigured: true, background: false });
    } catch {}
  };
function confirmRestart() {
  const dialog = $('restart-confirm');
  const accepted = new Promise((done) => {
    dialog.returnValue = '';
    $('restart-cancel').onclick = () => dialog.close('cancel');
    $('restart-proceed').onclick = () => dialog.close('proceed');
    dialog.addEventListener('close', () => done(dialog.returnValue === 'proceed'), { once: true });
  });
  dialog.showModal();
  $('restart-cancel').focus();
  return accepted;
}
$('server-restart').onclick = async () => {
  if (restarting) return;
  restarting = true;
  let restartedOk = false;
  try {
    const state = await refreshServer().catch(() => null);
    const canRestart = state ? (state.canRestart !== undefined ? state.canRestart : state.managed) : true;
    if (state && !canRestart) {
      await refreshServer();
      return;
    }
    const op = await pollOperationOnce().catch(() => null);
    let force = false;
    let cancelCurrent = false;
    // Confirmation before any cancel: impact of agents + current operation.
    if ((state && state.activeRuns) || (op && !op.terminal)) {
      if (op && op.cancellable) {
        if (!(await confirmRestart())) return;
        force = Boolean(state && state.activeRuns);
        cancelCurrent = true;
      } else if (op && !op.terminal && !op.cancellable) {
        // Noncancellable handoff (download/install): explicit retry, no fake cancel.
        updateStatus(t.updateDownloading + '…', false);
        return;
      } else {
        if (!(await confirmRestart())) return;
        force = true;
      }
    }
    $('server-state').textContent = t.restarting;
    restartedOk = false;
    try {
      const result = await invoke('desktop_server_restart', { force, cancelCurrent });
      if (result.restarted) {
        // No stale success UI: clear operation + refresh versions at once.
        currentOperation = null;
        if ($('update-cancel')) $('update-cancel').hidden = true;
        await refreshServer();
        $('server-agents').textContent = t.restarted;
        restartedOk = true;
        if (updatePending) {
          updatePending = false;
          await componentsAction('status');
          $('title').textContent = t.restarted;
          $('description').textContent = t.start;
          $('progress').hidden = true;
          $('start').textContent = t.start;
        }
      } else await refreshServer();
    } catch (error) {
      // Never fail silently: explicit busy vs failure.
      if (String(error) === 'update_busy') {
        $('server-state').textContent = t.componentsBusy;
      } else {
        throw error;
      }
    }
  } catch {
    $('server-state').textContent = t.restartFailed;
  } finally {
    restarting = false;
    // A final refresh must not clobber the post-restart confirmation line.
    if (!restartedOk) await refreshServer().catch(() => {});
  }
};
let busy = false;
function showError(value) {
  $('error').textContent = value;
  $('error').hidden = !value;
  $('logs').hidden = !value;
}
async function start(options = {}) {
  if (busy) return;
  const allowUnconfigured = Boolean(options.allowUnconfigured);
  const background = options.background !== undefined ? Boolean(options.background) : backgroundParam;
  busy = true;
  showError('');
  $('start').disabled = true;
  $('import').disabled = true;
  setPhase(t.connectingProbe);
  try {
    // B3: decide on live probe only (inside desktop_start), not persisted
    // prefs.started. Always persist validated components via activate when
    // ready, so explicit paths survive to installation.json before strict start.
    if (latestComponents?.ready) await invoke('desktop_components', { action: 'activate', component: null });
    setPhase(t.startingServer);
    const started = await invoke('desktop_start', { allowUnconfigured, background });
    if (started?.showUpdates && !allowUnconfigured && !background) {
      setupEnd(false);
      updatePending = true;
      showLauncher();
      $('title').textContent = t.updateGuideTitle;
      await componentsAction('diagnose');
      $('description').textContent = t.updateGuideNote;
      // The recovery guide must expose the restart action it asks the user to take.
      $('updates').hidden = false;
      await refreshServer().catch(() => {
        $('server-state').textContent = t.restartFailed;
        $('server-restart').disabled = true;
      });
      $('progress').hidden = true;
      $('start').textContent = t.componentsLater;
      return;
    }
    if (settings) {
      $('progress').hidden = true;
      $('start').disabled = false;
    }
    // Success: Rust navigates MAIN to Studio; keep connecting visible until navigation.
  } catch (error) {
    // Setup necessary: let boot run full diagnose with phases, not generic failure.
    if (isComponentsRequired(error) && !allowUnconfigured) throw error;
    // Occupied/transient or real failure: no duplicate spawn, no settings popup.
    $('progress').hidden = true;
    showLauncher();
    $('title').textContent = t.failure;
    showError(String(error));
    $('start').textContent = t.retry;
    $('start').disabled = false;
    $('start').focus();
    if (options.rethrow) throw error;
  } finally {
    busy = false;
    $('import').disabled = false;
  }
}
$('start').onclick = () => {
  // Later (not ready) explicitly opens Studio anyway; otherwise strict warm-first.
  const later = updatePending || (latestComponents && latestComponents.ready === false);
  return start({ allowUnconfigured: Boolean(later), background: backgroundParam });
};
$('logs').onclick = async () => {
  try {
    await invoke('desktop_logs');
  } catch (error) {
    showError(String(error));
  }
};
$('autostart').onchange = async () => {
  const input = $('autostart');
  input.disabled = true;
  try {
    await invoke('desktop_autostart', { enabled: input.checked });
    showError('');
  } catch {
    input.checked = !input.checked;
    showError(t.autostartError);
  } finally {
    input.disabled = false;
  }
};
$('import').onclick = async () => {
  const button = $('import');
  button.disabled = true;
  try {
    const selected = await invoke('desktop_choose_legacy');
    if (selected) {
      $('source').textContent = t.selected + selected;
      $('source').hidden = false;
      showError('');
    }
  } catch (error) {
    showError(String(error));
  } finally {
    button.disabled = false;
  }
};
(async () => {
  if (!invoke) {
    document.body.classList.remove('boot', 'boot-connecting');
    showError(t.noBridge);
    return;
  }
  try {
    const params = new URLSearchParams(location.search);
    const isQuit = params.has('quit');
    const state = await invoke('desktop_state');
    $('app-version').textContent = `v${state.version}`;
    $('updates').hidden = !settings && !isQuit;
    if ($('back-studio')) $('back-studio').hidden = !settings && !isQuit;
    startOperationPoll();
    if (isQuit) {
      // Tray quit when server is down: same main shell shows quit choice.
      showLauncher();
      $('title').textContent = t.quitTitle;
      $('description').textContent = t.quitNote;
      showQuitDialog();
      return;
    }
    if (settings) {
      void refreshServer()
        .then((s) => {
          // Absent/stopped server: canRestart false, allow start path.
          if (s && !s.running) {
            $('start').disabled = false;
            $('start').textContent = t.retry;
          }
        })
        .catch(() => {
          $('server-state').textContent = t.restartFailed;
          // Same surface fallback with obvious retry when status is down.
          $('start').disabled = false;
          $('start').textContent = t.retry;
        });
      void pollOperationOnce().catch(() => null);
    }
    const autostartKnown = typeof state.autostart === 'boolean';
    $('autostart').checked = state.autostart === true;
    $('autostart').indeterminate = !autostartKnown;
    $('autostart').disabled = !autostartKnown;
    if (!autostartKnown) $('startup-note').textContent = t.autostartUnavailable;
    $('start').disabled = false;
    if (state.imported) {
      $('import').hidden = true;
      $('import-note').textContent = t.imported;
    } else if (state.legacyRoot) {
      $('source').hidden = false;
      $('source').textContent = t.selected + state.legacyRoot;
    }
    const background = backgroundParam;
    if (settings) {
      // Settings: visible launcher controls, no auto-start. Run the same
      // read-only diagnose so components can be configured here; installs
      // still require an explicit click and never start automatically.
      showLauncher();
      const diagnosed = await componentsAction('diagnose');
      // Explicit recovery surface: explain the 0.9.8 step when legacy
      // evidence is present. Fresh installs have none, so stay silent.
      return;
    }
    if (background) {
      // Preserve hidden background: silent warm-first, allow unconfigured
      // so a missing receipt never pops a window or downloads. Native keeps
      // the window hidden on failure (explicit background arg) and logs.
      try {
        await invoke('desktop_start', { allowUnconfigured: true, background: true });
      } catch {
        // Stay hidden; Rust already logged desktop-error.log. Next foreground handles setup.
      }
      return;
    }
    // Foreground MAIN: connecting-first, live probe only (not persisted flag).
    showConnecting(t.connectingTitle, t.connectingNote, t.connectingProbe);
    try {
      await start({});
    } catch (error) {
      if (!isComponentsRequired(error)) throw error;
      // Setup necessary: concrete diagnose phases. When ready, persist via
      // activate before strict start so explicit paths are recorded (B3);
      // otherwise show launcher with Later/install.
      $('title').textContent = t.title;
      $('description').textContent = t.description;
      showLauncher();
      await componentsAction('diagnose');
      $('choices').hidden = false;
      if (latestComponents?.ready) {
        try {
          await start({});
        } catch (retryError) {
          if (!isComponentsRequired(retryError)) throw retryError;
          $('components').hidden = false;
        }
      } else {
        $('components').hidden = false;
        $('progress').hidden = true;
        setIntro(isFreshInstall(latestComponents) ? 'fresh' : 'repair');
        // Cold foreground with a known older engine receipt and no running
        // server: explain the 0.9.8 step. Empty fresh installs carry no
        // legacy evidence, so the predicate stays silent there.
      }
    }
  } catch (error) {
    document.body.classList.remove('boot-connecting');
    showError(String(error));
  }
})();
