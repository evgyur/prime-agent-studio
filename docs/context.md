# Moteur de contexte local

[English](en/context.md) · **Français** · [← Retour au README](../README.fr.md)

## Onglet Contexte (Bêta)

Ouvrez **Contexte (Bêta)** depuis **Ajouter un onglet** dans l’espace modulaire. En mode classique et sur mobile, ouvrez-le depuis **Session**. Comme les autres outils, cet onglet suit la conversation sélectionnée, sauf si vous le verrouillez.

Le panneau présente l’état de l’index local et les exclusions du projet. Le contexte du projet est désactivé par défaut : activez l’interrupteur du projet pour indexer. Des interrupteurs contrôlent ensuite le contexte automatique par projet et par conversation. Ils ne retirent pas les messages déjà envoyés à un fournisseur. Le panneau se met à jour par événements, sans interrogation périodique. À distance, ces données source sont réservées au contrôle complet authentifié ; le mode consultation ne les expose pas.

**Reconstruire** recrée l’index dérivé. Les exclusions sont des motifs relatifs au projet. **Fichiers exclus et motifs** présente les omissions automatiques et leur total. Les noms sensibles et les exclusions du projet ne sont pas recherchables. **Inclure les fichiers générés** active l’indexation et la recherche des verrous de dépendances, sources générées et minifiées ; ce réglage ne contourne jamais les noms sensibles ni les exclusions du projet. L’index reste local ; la V1 n’utilise ni service d’embeddings ni recherche sémantique. Un agent peut envoyer des extraits pertinents à son fournisseur configuré comme contexte ordinaire de conversation.

## Ce que reçoit l’agent

L’extension native expose trois outils en lecture seule, limités au projet :

| Outil | Résultat |
| --- | --- |
| `studio_code_search` | Blocs de code classés avec chemins et lignes ; classement SQLite FTS5 BM25. |
| `studio_code_symbols` | Définitions et références d’un symbole. |
| `studio_code_map` | Carte compacte d’un dossier : fichiers, principaux symboles et imports. |

La recherche sépare les noms camelCase, snake_case et kebab-case, ignore les mots fréquents français et anglais et associe un petit vocabulaire d’actions de code françaises à des termes anglais. Il s’agit d’une correspondance lexicale, pas d’une traduction générale. Les chemins et définitions correspondants sont favorisés ; les tables de traduction et README sont déclassés sauf demande explicite. Les résultats contiennent au plus deux extraits par fichier, d’environ 1 500 caractères. Les comptes retournés/totaux, `indexedAt` et le marqueur `stale` par résultat indiquent les limites et la fraîcheur. Relisez les fichiers périmés avant de vous appuyer sur leur contenu. Un chemin demandé mais exclu indique son motif.

Les symboles et imports reposent sur des heuristiques légères pour JavaScript/TypeScript, Python, C#, Rust et Go. Ce sont des aides à la navigation, pas des références exactes de compilateur ni un serveur de langage. L’historique Git apporte des signaux de changements récents et simultanés. Vérifiez la source actuelle avant de modifier le code.

Les très grands résultats d’outils sont plafonnés dès leur première transmission dans le contexte de requête. Des paliers stables réduisent aussi les résultats anciens selon les tours assistant et la taille du contexte, y compris pour un travail autonome avec un seul message utilisateur. Les résultats raccourcis conservent le début et la fin avec une marque explicite d’omission. Les messages utilisateur et les paires appel/résultat restent protégés ; l’historique natif n’est pas modifié. Le compactage guidé conserve les chemins du projet validés dans les arguments d’outils, les décisions et les tâches ouvertes, y compris pour une conversation française, dans les limites du hook natif disponible.

## Stockage et confidentialité

Les données dérivées résident dans `<dossier de données Studio>/code-index/<identifiant opaque du projet>/`, jamais dans les sources du projet indexé. L’identifiant est une empreinte, pas un nom de dossier. SQLite WAL permet aux lecteurs agents de coexister avec le worker d’indexation. Les réglages restent à côté de l’index du projet. Les anciennes épingles et copies de dossier de contexte sont ignorées, sans interrompre le service. Ce dossier contient des extraits de code : contrairement aux mesures de performance, il doit être traité comme des données source privées.

Le worker indexe les fichiers suivis par Git et les fichiers non suivis non ignorés par Git, y compris `.mts` et `.cts`. Il exclut les fichiers binaires, les fichiers de plus de 1 Mio, les noms sensibles comme `.env*`, les magasins d’identifiants et clés privées, ainsi que les chemins sortant du projet. Les sources qui manipulent des identifiants restent indexées : les jetons littéraux détectés, blocs de clés privées et chaînes affectées à forte entropie sont occultés avant stockage, sans écarter tout le fichier. Les noms d’en-têtes et références de variables sont préservés. Ce filtre lexical ne peut pas détecter tous les secrets possibles ; les exclusions explicites restent importantes. Les mises à jour sont incrémentales et s’exécutent hors du thread de l’interface et du serveur. Les événements de modification sont regroupés ; aucune boucle d’interrogation rapide n’est utilisée. Une reconstruction est utile après un grand changement de branche ou si les notifications du système de fichiers étaient indisponibles.

Une installation depuis les sources nécessite **Node.js 22.13 ou ultérieur** pour `node:sqlite`. Le runtime fourni l’intègre déjà. Aucun fichier du moteur installé n’est modifié : Studio charge ses extensions via l’option native `--extension`, également héritée par les enfants RLM.

### Limites de la V1

Les dossiers de travail Git secondaires ne reçoivent pas encore ce contexte automatique : le lancement les désactive explicitement au lieu de rechercher dans l’index du dépôt principal. Le projet principal reste pris en charge. Le worker limite un index à 10 000 fichiers et 64 Mio de sources ; SQLite est plafonné à environ 256 Mio. Les résultats sont des extraits bornés, pas une analyse exhaustive du dépôt.
