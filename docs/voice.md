# Messages vocaux

**Français** · [English](en/voice.md) · [← Retour au README](../README.fr.md)

Le microphone enregistre un message vocal. **Envoyer** arrête l'enregistrement, le transcrit et envoie le texte obtenu par le composeur habituel. **Annuler** abandonne l'enregistrement. Le modèle de conversation reçoit du texte, pas l'audio.

La fonction est facultative et désactivée tant que le serveur Studio n'est pas configuré. Choisissez **Groq avec votre propre clé API** pour démarrer simplement avec un service hébergé, ou **Whisper en local** pour effectuer la reconnaissance sur votre machine. Ces services sont indépendants du modèle de programmation et de son abonnement ; Studio ne fournit pas de compte de transcription et ne télécharge pas automatiquement de modèle.

## Groq : configuration hébergée recommandée

Créez une clé dans [Groq Console](https://console.groq.com/keys). Définissez les variables suivantes sur la machine qui exécute **le serveur Studio**, puis redémarrez Studio. Exemple PowerShell depuis le dossier de Studio :

```powershell
$env:PRIME_STUDIO_VOICE_PROVIDER = 'groq'
$env:GROQ_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Groq API key' -AsSecureString)).Password
npm start
```

Pour une configuration persistante, utilisez les paramètres d'environnement ou de secrets du gestionnaire de services. Ne placez jamais une vraie clé dans Git. La clé reste sur le serveur Studio et n'est jamais renvoyée au navigateur.

Le modèle par défaut est `whisper-large-v3-turbo`. Définissez `PRIME_STUDIO_VOICE_MODEL=whisper-large-v3` pour choisir cet autre modèle. Groq présente Turbo comme son option prix/performance et Large V3 comme l'alternative privilégiant la précision dans sa [documentation de transcription](https://console.groq.com/docs/speech-to-text). L'audio est envoyé à Groq lorsque vous appuyez sur Envoyer ; ses limites de compte, sa facturation et ses politiques de données s'appliquent.

## Whisper : reconnaissance locale

Lancez un [serveur HTTP whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) avec un modèle Whisper multilingue téléchargé. Installez FFmpeg dans le PATH de ce serveur et activez `--convert` : les navigateurs enregistrent en WebM, Ogg ou MP4, et non dans le format WAV attendu par défaut. Suivez les instructions du projet pour la compilation, les binaires et les modèles adaptés à votre système. Exemple de commande :

```text
whisper-server -m /path/to/ggml-base.bin --host 127.0.0.1 --port 8080 --convert -l auto
```

Sous Windows, utilisez `whisper-server.exe` et un chemin Windows pour le modèle. Écoutez sur l'interface de bouclage et exécutez le service sans droits administrateur. Cet exemple de serveur accepte des fichiers et invoque FFmpeg ; isolez-le au lieu de l'exposer directement à Internet.

Dans une autre fenêtre PowerShell, lancez Studio ainsi :

```powershell
$env:PRIME_STUDIO_VOICE_PROVIDER = 'whisper'
$env:PRIME_STUDIO_WHISPER_URL = 'http://127.0.0.1:8080/inference'
$env:PRIME_STUDIO_VOICE_TIMEOUT_MS = '300000'
npm start
```

L'URL désigne le point de transcription complet, pas une URL de base. Studio envoie les champs multipart `file` et `response_format=json` et attend `{ "text": "..." }`. whisper.cpp charge le modèle ; Studio n'envoie ni nom de modèle ni clé Groq dans ce mode. L'administrateur peut configurer un autre point HTTP(S) respectant ce contrat. Les identifiants dans l'URL, paramètres de requête et fragments sont refusés ; les redirections ne sont pas suivies.

« Local » désigne l'environnement du serveur Studio. Avec Docker, le bouclage appartient au conteneur ; configurez un service Whisper isolé et accessible s'il tourne ailleurs. Il n'existe aucun basculement automatique de Whisper vers Groq. La vitesse dépend du matériel et de la taille du modèle.

## Enregistrement et accès

- Utilisez un navigateur ou WebView prenant en charge le microphone et MediaRecorder. La capture exige un contexte sécurisé : localhost sur le PC hôte ou HTTPS sur un appareil distant. Un accès HTTP distant peut afficher Studio tout en bloquant le microphone.
- Autorisez le microphone lorsque cela vous est demandé. Une application intégrant une WebView doit également autoriser la capture audio ; l'interface web ne peut pas accorder une permission Android ou Windows.
- L'interface arrête la capture après cinq minutes et attend Envoyer ou Annuler. La limite est de 10 Mio et d'une transcription simultanée par serveur Studio. Le serveur vérifie la taille et la signature du conteneur, pas la durée audio décodée.
- Fermer la boîte de dialogue ou quitter la page annule la capture/transcription et libère le microphone. Atteindre la limite de temps ne déclenche aucun envoi automatique.
- Si la conversation, le modèle, le brouillon ou les pièces jointes changent pendant la transcription, Studio propose une insertion explicite au lieu d'envoyer dans ce contexte modifié. Un envoi de message refusé conserve le texte comme brouillon.
- Les accès distants en consultation ne peuvent pas transcrire. Les clients authentifiés avec contrôle complet utilisent les mêmes limites et contrôles d'origine que l'interface locale.

## Configuration et données

| Variable                        | Signification                                                           |
| ------------------------------- | ----------------------------------------------------------------------- |
| `PRIME_STUDIO_VOICE_PROVIDER`   | `groq` ou `whisper` ; absente, désactive la fonction                    |
| `GROQ_API_KEY`                  | Clé Groq côté serveur ; ignorée avec Whisper                            |
| `PRIME_STUDIO_VOICE_MODEL`      | Groq `whisper-large-v3-turbo` par défaut ou `whisper-large-v3`          |
| `PRIME_STUDIO_WHISPER_URL`      | Point Whisper ; `http://127.0.0.1:8080/inference` par défaut            |
| `PRIME_STUDIO_VOICE_TIMEOUT_MS` | Délai de chargement/transcription, 1 000–600 000 ms ; 90 000 par défaut |

Redémarrez Studio après modification de l'environnement. Une configuration invalide désactive le microphone. Les erreurs du fournisseur ne révèlent ni son corps de réponse ni les identifiants.

Studio conserve l'audio en mémoire et n'enregistre ni ne journalise les captures ou les réponses de transcription. Une fois inséré ou envoyé, le texte suit le stockage habituel des brouillons et de l'historique. Le fournisseur reste distinct : consultez les politiques de Groq ou le comportement de votre serveur Whisper concernant les fichiers temporaires et les journaux. La conversion FFmpeg peut notamment créer des fichiers temporaires côté Whisper.
