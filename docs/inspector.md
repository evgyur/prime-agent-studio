# Session, agents et fichiers

[English](en/inspector.md) · **Français** · [← Retour au README](../README.fr.md)

Le bouton de panneau en haut à droite du chat ouvre l’espace de travail. Il reste à côté de la conversation sur PC et occupe la hauteur de l’écran sur mobile. Fermer le panneau ou un aperçu conserve la session et son brouillon.

## Session

Retrouvez le projet, l’état de la session, les exécutions actives et l’export de la conversation. Le suivi distingue la génération d’une réponse, l’exécution d’un outil, la réduction du contexte et l’attente des sous-agents.

Le statut du chat distingue aussi une erreur de quota ou de fournisseur. Ces indications suivent les événements du moteur ; elles ne modifient ni le modèle sélectionné ni les limites de reprise.

La consommation additionne les données enregistrées par Prime Agent sur la branche actuelle de la conversation : tokens entrants hors cache, sortants, lus depuis le cache et écrits dans le cache. Le **taux de cache** est la part des tokens d’entrée servis par le cache : lus ÷ (entrants + lus + écrits), sans les tokens sortants. Le coût estimé apparaît uniquement si le moteur le fournit ; sinon il reste **inconnu**, pas nul. Il ne correspond pas à la facturation de votre abonnement.

Le total inclut les sous-agents : chaque requête est comptée une seule fois, avec sa consommation propre, y compris pour un sous-agent encore en cours. Le détail de l’agent principal reste disponible. Son état ouvert ou fermé est conservé pendant les actualisations et au retour dans la session. Le total est marqué **partiel** si un sous-agent est introuvable, si son historique dépasse 16 Mio ou au-delà de 200 sous-agents. Le coût des résumés de compaction n’est pas inclus ici.

Sous la zone de saisie, une ligne discrète indique **Contexte x % · Cache y %**, dans chaque onglet de conversation et sur mobile. Pendant une exécution, elle reprend la mesure du moteur et se met à jour à chaque message, compaction ou fin de tour, sans interrogation périodique. Au repos, elle montre la taille de la **dernière requête** par rapport à la fenêtre du modèle, comme l’indique son infobulle. Elle passe en orange à 80 % et en rouge à 95 % ; elle disparaît quand la valeur est inconnue, par exemple juste après une compaction.

## Performance

Ajoutez **Performance** avec le menu **Ajouter un onglet** de l’espace modulaire. L’onglet suit le projet de la conversation active ; son verrou conserve ce projet, même si la conversation source est fermée. En disposition classique et sur mobile, le bouton **Performance** de Session ouvre la même vue dans une fenêtre.

Choisissez **Ce projet** ou **Tous les projets**, puis Aujourd’hui, 7, 30 ou 90 jours. La période initiale est de 7 jours, avec des journées UTC. La vue réunit le coût estimé, les quatre catégories de tokens, le taux de cache, les exécutions démarrées, réussies, échouées et arrêtées, la durée médiane et le délai médian du premier jeton. Les anciennes sessions sans chronométrage indiquent **Non disponible**. Un coût absent reste **Inconnu**, avec le nombre de messages concernés.

Le graphique quotidien montre le coût ou les tokens. Le tableau des modèles classe vos propres tâches par coût ou nombre d’exécutions. Le taux de réussite est le nombre d’exécutions réussies divisé par la somme des réussies et des échouées. Les arrêts manuels et les arrêts de budget sont exclus de ce taux. Leur nombre apparaît séparément dans les indicateurs et dans l’infobulle du taux des tableaux. Sans réussite ni échec, le taux est **Non disponible**. Le coût par exécution terminée inclut le coût total de la période. Les erreurs HTTP 4xx et 5xx sont comptées séparément. **Tous les projets** ajoute un tableau avec leurs noms, sans chemins. Un bloc **Utilité de la recherche de code** donne, par outil (`studio_code_search`, `studio_code_symbols`, `studio_code_map`), les appels, la part utile, la part de repli et la taille d’échantillon. Un appel est utile quand un fichier retourné est ouvert dans les cinq appels d’outils suivants ; il y a repli quand une recherche shell (`grep`, `rg`, `findstr`, `Select-String`) ou une lecture manuelle suit dans les trois appels suivants. Seuls des comptes sont enregistrés, jamais de chemins ni de contenus. En dessous de cinq appels, les taux affichent **échantillon trop petit** au lieu d’un pourcentage.

Les mesures se chargent à l’ouverture, à la fin d’une exécution si la vue est visible, ou avec **Actualiser**, sans interrogation périodique. Une reprise d’historique, une lecture incomplète ou une limite atteinte sont signalées avec **Réessayer**. Le journal conserve 90 jours. Contrairement au bloc Session, il inclut les résumés de compaction enregistrés.

## Agents

Les réglages des sous-agents sont accessibles dès l’ouverture d’une nouvelle conversation, avant le premier message. Ils dépendent du projet choisi ; aucune session Prime Agent ni aucun agent ne sont créés pour les modifier.

En haut de l’onglet, **Sous-agents du projet** utilise les valeurs communes définies dans les préférences du PC lorsque **Globaux** est sélectionné ; les sélecteurs de modèle et de réflexion sont alors masqués. Choisissez **Ce projet** pour les afficher et personnaliser les prochaines délégations. Le sélecteur de modèle reprend le catalogue, la recherche et les favoris des conversations. Un choix s’enregistre automatiquement pour toutes les sessions du projet ; revenir à **Globaux** supprime l’exception. Les agents déjà créés conservent leurs réglages. Ce bloc est utilisable sur PC et sur mobile avec le contrôle complet.

L’agent principal et ses sous-agents apparaissent dans leur hiérarchie, avec leur modèle, leur **niveau de réflexion**, leur état et le dernier résumé disponible. Le niveau provient de la session active ou des changements enregistrés sur sa branche actuelle, jamais du réglage par défaut du Studio. **Non renseignée** indique une donnée absente d’une ancienne session. Cliquez sur une carte pour lire ses échanges, puis utilisez **Actualiser** pour en récupérer les derniers messages.

Les notes envoyées par `rlm.progress_note(...)` apparaissent sur la carte du sous-agent avec sa dernière activité, lorsque le moteur fournit ces données. L’ancienneté utilise le temps actif mesuré par le moteur : une mise en veille du PC ne rend pas les agents artificiellement inactifs. Pendant l’exécution d’un outil, le Studio ne déduit pas une inactivité de sa durée. Ces notes sont du texte et ne constituent pas un verdict de réussite.

Pendant une exécution lancée par le Studio, la liste se rafraîchit toutes les quelques secondes tant que le panneau est visible. Un agent ayant terminé une première tâche peut travailler à nouveau : son activité actuelle est prioritaire sur son ancien statut « terminé ».

Hors exécution, le Studio affiche les délégations conservées dans le registre natif de Prime Agent. **Historique** signifie que des échanges ont été retrouvés mais que l’état actuel de cet agent n’est pas connu. Certaines anciennes sessions n’ont plus de délégations enregistrées. L’indication d’indisponibilité du suivi ne provoque aucun redémarrage.

Le suivi utilise le protocole de Prime Agent **0.9.7**. Consulter une carte ne reprend pas, n’arrête pas et ne détache pas l’agent. La liste présente au plus 200 sous-agents et chaque aperçu les 150 derniers messages ; les raisonnements internes ne sont pas développés dans cet aperçu.

## Fichiers

- **Modifications** affiche les fichiers modifiés, ajoutés et supprimés du projet Git. Cliquez pour lire les ajouts en vert et suppressions en rouge, ou basculez vers **Contenu**.
- **Parcourir** ouvre les dossiers et leurs fichiers. Le fil de navigation remonte au dossier parent ; **Afficher la suite** charge les entrées suivantes par pages de 100.
- **Ouvrir** lance l’application associée au fichier sur le PC qui héberge le Studio. Depuis la PWA ou un autre appareil, le bouton indique **Ouvrir sur le PC**. Le mode distant en lecture seule garde les aperçus mais ne permet pas de lancer une application sur le PC.

Les fichiers **Markdown** (`.md`, `.markdown`, `.mdown`, `.mkd`) s’affichent avec leurs titres, listes, tableaux, citations et blocs de code. Le JSON est indenté dans l’aperçu, en conservant les valeurs originales. **Aperçu / Source** permet de basculer vers le texte exact du fichier sans le recharger. Les autres fichiers texte conservent leur indentation et les fichiers HTML restent du texte, sans exécution.

Le diff compare le contenu actuel au dernier commit, en incluant les changements indexés et ceux du dossier de travail. Il concerne **tout le projet** : plusieurs sessions ou une modification manuelle peuvent contribuer aux mêmes fichiers. Aucune attribution automatique à un agent n’est faite. Sans Git, le parcours des fichiers reste disponible.

Les liens Markdown vers les documents du projet et les références de fichier écrites en code dans les messages deviennent cliquables quand le fichier existe. Ils ouvrent un aperçu avec le même bouton **Ouvrir**, sans changer de session ni perdre le brouillon. Les chemins relatifs, absolus et `file://` sont reconnus, y compris les références à une ligne ou à une plage de lignes (`app.js:12`, `app.js:62-63`, `app.js#L4-L9`).

Un simple nom de fichier ou une fin de chemin (`src/app.js` pour `web/src/app.js`) est recherché dans la liste des fichiers du projet. Dans un dépôt Git, cette liste respecte `.gitignore` : les dossiers de build ne cachent jamais le vrai fichier. Si plusieurs fichiers correspondent, le Studio vous laisse choisir. Avant d’afficher un message, le Studio vérifie ses références en une seule requête : un numéro de version, un nom de branche ou un fichier absent reste du texte simple, et un lien Markdown vers un fichier absent apparaît barré, avec une info-bulle. Les agents reçoivent aussi une consigne : écrire les chemins depuis le dossier du projet.

Les liens ne sont plus limités à certaines extensions : un fichier binaire, comme un `.exe` ou un `.zip`, peut ouvrir le panneau sans être exécuté. Le menu contextuel d’un lien propose **Ouvrir**, **Ouvrir le dossier** et **Copier le chemin**. Le panneau comporte aussi **Ouvrir le dossier**, à côté d’**Ouvrir**, pour ouvrir le dossier contenant le fichier sur le PC hôte.

**Ouvrir le dossier** n’est pas limité au projet : un chemin absolu, un lien `file://` ou un chemin relatif peut désigner n’importe quel dossier existant accessible au PC. Pour un fichier, son dossier parent s’ouvre ; pour un dossier, ce dossier s’ouvre directement. Aucun enregistrement comme projet n’est requis. Cette action explicite ouvre l’Explorateur sur le PC hôte, sans transférer le contenu vers le navigateur. Elle reste indisponible en consultation seule et aux jetons de l’API publique.

Les aperçus acceptent les textes UTF-8 jusqu’à 512 Kio et les images PNG, JPEG, GIF ou WebP jusqu’à 8 Mio. La mise en forme concerne uniquement l’affichage : elle ne modifie pas les fichiers du projet. Les fichiers supprimés ont un diff mais ne peuvent plus être ouverts. Sous Windows, les scripts qui s’exécuteraient à l’ouverture (`.js`, `.ps1`, `.bat`, `.py`, …) s’ouvrent comme texte dans le Bloc-notes, tandis que les pages web et le code non exécutable s’ouvrent avec l’application associée ; les exécutables et raccourcis ne sont pas lancés par cette commande. Si un fichier texte n’a pas d’application associée, le Studio utilise le Bloc-notes. Pour les scripts exécutables (hors `.reg`/`.inf`), un bouton **Exécuter** demande confirmation — nom, chemin relatif et avertissement que le script tourne sur le PC avec vos droits Windows — puis ouvre une nouvelle fenêtre de console qui reste ouverte dans le dossier du script.

Le parcours du contenu, les aperçus et les téléchargements restent limités aux projets enregistrés et au code d’accès distant habituel. Les dossiers techniques (`.git`, `node_modules`, caches), les données privées du moteur et du Studio et les liens sortant du projet sont exclus. Un lien explicite vers `.local` est accessible uniquement si ce dossier ne contient pas les données privées du Studio. Le mode distant en lecture seule autorise ces consultations sans autoriser de commandes sur l’agent.
