# Moteur de contexte local

[English](en/context.md) · **Français** · [← Retour au README](../README.fr.md)

## Onglet Contexte

Ouvrez **Contexte** depuis **Ajouter un onglet** dans l’espace modulaire. En mode classique et sur mobile, ouvrez-le depuis **Session**. Comme les autres outils, cet onglet suit la conversation sélectionnée, sauf si vous le verrouillez.

Le panneau présente le dossier transmis à l’agent, les fichiers épinglés, l’état de l’index local et les exclusions du projet. Utilisez **Épingler au contexte** dans Fichiers ou sur un résultat de recherche de contexte pour conserver un fichier dans le dossier de la prochaine conversation. Les épingles sont des références, pas des copies intégrales. Retirez une épingle dans Contexte. Des interrupteurs contrôlent le contexte automatique par projet et par conversation. Ils ne retirent pas les messages déjà envoyés à un fournisseur. Le panneau se met à jour par événements, sans interrogation périodique. À distance, ces données source sont réservées au contrôle complet authentifié ; le mode consultation ne les expose pas.

**Reconstruire** recrée l’index dérivé. Les exclusions sont des motifs relatifs au projet. Les fichiers exclus et les noms sensibles ne sont pas recherchables. L’index reste local ; la V1 n’utilise ni service d’embeddings ni recherche sémantique. Un agent peut envoyer des extraits pertinents à son fournisseur configuré comme contexte ordinaire de conversation.

## Ce que reçoit l’agent

Avant le premier tour, un dossier borné fournit les fichiers probablement pertinents avec leurs lignes, les épingles, les commandes de test et de compilation détectées, et les références à `AGENTS.md` ou `CLAUDE.md`. Il s’agit d’un message de contexte normal, pas d’un remplacement du prompt système. Le préfixe stable du cache fournisseur est ainsi préservé. Le dossier n’est injecté qu’une fois par conversation, pas à chaque message utilisateur. Un index absent ou en cours de construction ne bloque pas le démarrage.

L’extension native expose trois outils en lecture seule, limités au projet :

| Outil | Résultat |
| --- | --- |
| `studio_code_search` | Blocs de code classés avec chemins et lignes ; classement SQLite FTS5 BM25. |
| `studio_code_symbols` | Définitions et références d’un symbole. |
| `studio_code_map` | Carte compacte d’un dossier : fichiers, principaux symboles et imports. |

Les résultats sont bornés. Les symboles et imports reposent sur des heuristiques légères pour JavaScript/TypeScript, Python, C#, Rust et Go. Ce sont des aides à la navigation, pas des références exactes de compilateur ni un serveur de langage. L’historique Git apporte des signaux de changements récents et simultanés. Vérifiez la source actuelle avant de modifier le code.

Les très grands résultats d’outils anciens peuvent être remplacés, dans le contexte de requête, par des références courtes selon des paliers stables. Les tours récents, les messages utilisateur et les paires appel/résultat restent protégés. L’historique natif n’est pas modifié. Le compactage guidé conserve les références de fichiers, les décisions et les tâches ouvertes dans les limites du hook natif disponible.

## Stockage et confidentialité

Les données dérivées résident dans `<dossier de données Studio>/code-index/<identifiant opaque du projet>/`, jamais dans les sources du projet indexé. L’identifiant est une empreinte, pas un nom de dossier. SQLite WAL permet aux lecteurs agents de coexister avec le worker d’indexation. Les réglages et copies du dossier de contexte restent à côté de l’index du projet. Ce dossier contient des extraits de code : contrairement aux mesures de performance, il doit être traité comme des données source privées.

Le worker indexe les fichiers suivis par Git et les fichiers non suivis non ignorés par Git. Il exclut les fichiers binaires, les fichiers de plus de 1 Mio, les noms sensibles comme `.env*`, les identifiants et clés privées, ainsi que les chemins sortant du projet. Les mises à jour sont incrémentales et s’exécutent hors du thread de l’interface et du serveur. Les événements de modification sont regroupés ; aucune boucle d’interrogation rapide n’est utilisée. Une reconstruction est utile après un grand changement de branche ou si les notifications du système de fichiers étaient indisponibles.

Une installation depuis les sources nécessite **Node.js 22.13 ou ultérieur** pour `node:sqlite`. Le runtime fourni l’intègre déjà. Aucun fichier du moteur installé n’est modifié : Studio charge ses extensions via l’option native `--extension`, également héritée par les enfants RLM.

### Limites de la V1

Les dossiers de travail Git secondaires ne reçoivent pas encore ce contexte automatique : le lancement les désactive explicitement au lieu de rechercher dans l’index du dépôt principal. Le projet principal reste pris en charge. Le worker limite un index à 10 000 fichiers et 64 Mio de sources ; SQLite est plafonné à environ 256 Mio. Les résultats sont des extraits bornés, pas une analyse exhaustive du dépôt.
