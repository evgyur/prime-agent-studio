# Messages vocaux

**Français** · [English](en/voice.md) · [← Retour au README](../README.fr.md)

Le bouton microphone du compositeur enregistre un message vocal. **Envoyer** arrête l’enregistrement, le transcrit et envoie le texte obtenu par le compositeur habituel. **Annuler** abandonne l’enregistrement. Le modèle de la conversation reçoit du texte, pas l’audio.

La fonction est facultative. Activez-la dans **Préférences › Outils › Messages vocaux**, puis choisissez **Groq** (service hébergé, avec votre clé API) ou **Whisper local** (reconnaissance sur votre machine). Ce réglage est propre à ce PC et n’est pas synchronisé. Ces services sont indépendants du modèle de programmation et de son abonnement ; Studio ne fournit pas de compte de transcription et ne télécharge aucun modèle.

## Groq

1. Créez une clé dans [Groq Console](https://console.groq.com/keys).
2. Ajoutez-la dans **Préférences › Modèles et agents › Fournisseurs › Groq**. Le bouton **Gérer les connexions** de la section Messages vocaux ouvre le même panneau.
3. Dans **Préférences › Outils › Messages vocaux**, choisissez **Groq · clé API**.

Studio utilise la même clé que le fournisseur de modèles Groq : une seule clé à gérer. À défaut, la variable d’environnement `GROQ_API_KEY` est utilisée, comme pour les modèles. La section indique la source de la clé utilisée. La clé reste sur le PC hôte : elle n’est jamais renvoyée au navigateur ni à un appareil distant.

Le modèle par défaut est **Whisper Large V3 Turbo**, rapide. **Whisper Large V3** privilégie la précision ([documentation Groq](https://console.groq.com/docs/speech-to-text)). L’audio est envoyé à Groq lorsque vous appuyez sur Envoyer ; les limites, la facturation et la politique de données de votre compte Groq s’appliquent.

## Whisper local

Lancez un [serveur HTTP whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) avec un modèle Whisper multilingue. Installez FFmpeg dans le PATH de ce serveur et activez `--convert` : les navigateurs enregistrent en WebM, Ogg ou MP4, et non en WAV. Exemple :

```text
whisper-server -m /chemin/vers/ggml-base.bin --host 127.0.0.1 --port 8080 --convert -l auto
```

Sous Windows, utilisez `whisper-server.exe` et un chemin Windows pour le modèle. Écoutez sur l’interface de bouclage et lancez le service sans droits administrateur ; ne l’exposez pas directement à Internet.

Dans **Préférences › Outils › Messages vocaux**, choisissez **Whisper local**. L’adresse par défaut est `http://127.0.0.1:8080/inference`. Indiquez le point de transcription complet, pas une adresse de base. Studio envoie les champs multipart `file` et `response_format=json` et attend `{ "text": "..." }` ; tout service HTTP(S) respectant ce contrat convient. Les identifiants dans l’adresse, les paramètres de requête et les fragments sont refusés ; les redirections ne sont pas suivies. Il n’existe aucun basculement automatique vers Groq.

« Local » désigne la machine qui exécute le serveur Studio. Avec Docker, le bouclage appartient au conteneur. Augmentez le **délai maximal de transcription** si votre matériel est lent : de 30 s à 10 min, 90 s par défaut.

## Enregistrement

- Utilisez un navigateur ou une WebView prenant en charge le microphone et MediaRecorder. La capture exige un contexte sécurisé : localhost sur le PC hôte, ou HTTPS sur un appareil distant.
- Autorisez le microphone lorsque cela vous est demandé. Une application intégrant une WebView doit aussi autoriser la capture audio.
- La capture s’arrête après cinq minutes et attend Envoyer ou Annuler. L’envoi est limité à 10 Mio, avec une transcription à la fois par serveur Studio.
- En cas d’erreur temporaire (service indisponible, limite de débit, délai dépassé, autre transcription en cours), l’enregistrement est conservé : **Réessayer** le renvoie sans réenregistrer.
- Si la conversation, le modèle, le brouillon ou les pièces jointes changent pendant la transcription, rien n’est envoyé automatiquement : **Insérer le texte** l’ajoute au brouillon d’origine. Si la conversation d’origine n’existe plus, **Copier le texte** le conserve.
- Annuler, fermer la boîte de dialogue ou quitter la page libère le microphone. Passer à un autre onglet libère aussi le microphone pendant l’enregistrement ; une transcription déjà envoyée continue et son résultat vous attend.
- Le bouton microphone utilise toujours l’éditeur visible, y compris en fenêtre étroite ou sur mobile.
- Les accès distants en consultation ne peuvent ni transcrire ni modifier ce réglage. Les appareils en contrôle complet utilisent les mêmes limites et contrôles d’origine que l’interface locale.

## Données

Studio conserve l’audio en mémoire et n’enregistre ni ne journalise les captures ou les réponses de transcription. Une fois inséré ou envoyé, le texte suit le stockage habituel des brouillons et de l’historique. Les réglages vocaux sont enregistrés dans `voice.json`, dans le dossier de données de Studio ; ils ne contiennent aucune clé. Le fournisseur reste distinct : consultez la politique de Groq ou le comportement de votre serveur Whisper concernant les fichiers temporaires et les journaux. La conversion FFmpeg peut créer des fichiers temporaires côté Whisper.
