# Voice prompts

**English** · [Français](../voice.md) · [← Back to README](../../README.md)

The microphone records a voice message. **Send** stops recording, transcribes it, and sends the resulting text through the ordinary conversation composer. **Cancel** discards the recording. The conversation model receives text, not audio.

Voice is optional and disabled until the Studio server is configured. Start with **Groq and your own API key** for straightforward hosted transcription, or run **Whisper locally** to keep recognition on your own machine. These are independent of your coding model or its subscription; Studio does not bundle a transcription account or download models automatically.

## Groq: recommended hosted setup

Create a key in [Groq Console](https://console.groq.com/keys). Set the following environment variables on the machine running **the Studio server**, then restart Studio. For example, in PowerShell from the Studio directory:

```powershell
$env:PRIME_STUDIO_VOICE_PROVIDER = 'groq'
$env:GROQ_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Groq API key' -AsSecureString)).Password
npm start
```

Use your service manager's secret/environment settings for persistent configuration. Do not put a real key in source control. The key stays on the Studio server and is never returned to the browser.

The default is `whisper-large-v3-turbo`. Set `PRIME_STUDIO_VOICE_MODEL=whisper-large-v3` if you prefer that model. Groq describes Turbo as its price/performance option and Large V3 as the accuracy-oriented alternative in its [speech-to-text documentation](https://console.groq.com/docs/speech-to-text). Audio is sent to Groq when you press Send; Groq's account limits, billing and data policies apply.

## Whisper: local recognition

Run a [whisper.cpp HTTP server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) with a downloaded multilingual Whisper model. Install FFmpeg on that server's PATH and enable `--convert`, because browsers record WebM, Ogg or MP4 rather than the WAV input the server expects by default. Follow the project's build/release and model-download instructions for your operating system. A typical server command is:

```text
whisper-server -m /path/to/ggml-base.bin --host 127.0.0.1 --port 8080 --convert -l auto
```

On Windows, use `whisper-server.exe` and a Windows model path. Bind the service to loopback and run it without administrator privileges. The example server accepts uploads and invokes FFmpeg; keep it isolated rather than exposing it directly to the internet.

In a separate PowerShell window, start Studio with:

```powershell
$env:PRIME_STUDIO_VOICE_PROVIDER = 'whisper'
$env:PRIME_STUDIO_WHISPER_URL = 'http://127.0.0.1:8080/inference'
$env:PRIME_STUDIO_VOICE_TIMEOUT_MS = '300000'
npm start
```

The URL is the complete transcription endpoint, not a base URL. Studio sends multipart `file` and `response_format=json`, and expects `{ "text": "..." }`. The model is loaded by whisper.cpp; Studio does not send a model name or a Groq key in this mode. The administrator can configure another HTTP(S) endpoint with this same contract. URL credentials, query strings and fragments are rejected, and redirects are not followed.

"Local" refers to the Studio server's environment. In Docker, loopback belongs to the container; configure an isolated reachable Whisper service if it runs elsewhere. There is no automatic fallback from Whisper to Groq. Hardware and model size determine transcription speed.

## Recording and access

- Use a browser or WebView that supports microphone capture and MediaRecorder. Capture requires a secure context: localhost on the host PC, or HTTPS for a remote phone/computer. Plain remote HTTP may let you read Studio while blocking microphone access.
- Grant microphone permission when prompted. A wrapper application must also allow audio capture; changing the web UI cannot grant an Android or Windows permission.
- The UI stops at five minutes and waits for an explicit Send or Cancel. Uploads are limited to 10 MiB; only one transcription runs at a time per Studio server. The server checks the byte limit and container signature, not decoded audio duration.
- Closing the dialog or leaving the page cancels capture/transcription and releases microphone tracks. No automatic upload occurs when the time limit is reached.
- If the conversation, model, draft or attachments change while transcription is pending, Studio offers explicit insertion instead of sending into the changed context. A rejected normal message send retains the text as a draft.
- Remote consultation clients cannot transcribe. Authenticated full-control clients use the same upload limits and origin checks as the local interface.

## Configuration and data

| Variable                        | Meaning                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `PRIME_STUDIO_VOICE_PROVIDER`   | `groq` or `whisper`; unset disables voice                          |
| `GROQ_API_KEY`                  | Server-side Groq credential; ignored in Whisper mode               |
| `PRIME_STUDIO_VOICE_MODEL`      | Groq `whisper-large-v3-turbo` (default) or `whisper-large-v3`      |
| `PRIME_STUDIO_WHISPER_URL`      | Whisper endpoint; defaults to `http://127.0.0.1:8080/inference`    |
| `PRIME_STUDIO_VOICE_TIMEOUT_MS` | Upload/transcription timeout, 1,000–600,000 ms; defaults to 90,000 |

Restart Studio after changing its environment. Invalid configuration disables the microphone feature. Provider errors never expose upstream response bodies or credentials.

Studio buffers audio in memory and does not save or log recordings or transcription responses. Once inserted or sent, the transcript follows ordinary draft/history storage. The transcription provider is separate: review Groq's policies or your local Whisper server's temporary-file and logging behavior. In particular, FFmpeg conversion can create temporary files in the Whisper service.
