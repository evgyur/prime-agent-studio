# Voice messages

**English** · [Français](../voice.md) · [← Back to README](../../README.md)

The microphone button in the composer records a voice message. **Send** stops recording, transcribes it, and sends the resulting text through the ordinary composer. **Cancel** discards the recording. The conversation model receives text, not audio.

Voice messages are optional. Turn them on in **Preferences › Tools › Voice messages**, then choose **Groq** (hosted, with your API key) or **Local Whisper** (recognition on your own machine). This setting is specific to this PC and is not synced. These services are independent of your coding model or its subscription; Studio does not bundle a transcription account or download models.

## Groq

1. Create a key in [Groq Console](https://console.groq.com/keys).
2. Add it in **Preferences › Models & agents › Providers › Groq**. The **Manage connections** button in the Voice messages section opens the same panel.
3. In **Preferences › Tools › Voice messages**, choose **Groq · API key**.

Studio uses the same key as the Groq model provider, so there is one key to manage. Without it, the `GROQ_API_KEY` environment variable is used, as for models. The section shows which key source is in use. The key stays on the host PC and is never returned to the browser or to a remote device.

The default model is **Whisper Large V3 Turbo**, which is fast. **Whisper Large V3** favors accuracy ([Groq documentation](https://console.groq.com/docs/speech-to-text)). Audio is sent to Groq when you press Send; your Groq account limits, billing and data policies apply.

## Local Whisper

Run a [whisper.cpp HTTP server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server) with a multilingual Whisper model. Install FFmpeg on that server's PATH and enable `--convert`, because browsers record WebM, Ogg or MP4 rather than WAV. For example:

```text
whisper-server -m /path/to/ggml-base.bin --host 127.0.0.1 --port 8080 --convert -l auto
```

On Windows, use `whisper-server.exe` and a Windows model path. Bind the service to loopback, run it without administrator rights, and do not expose it directly to the internet.

In **Preferences › Tools › Voice messages**, choose **Local Whisper**. The default address is `http://127.0.0.1:8080/inference`. Enter the complete transcription endpoint, not a base URL. Studio sends multipart `file` and `response_format=json` and expects `{ "text": "..." }`; any HTTP(S) service with this contract works. URL credentials, query strings and fragments are rejected, and redirects are not followed. There is no automatic fallback to Groq.

"Local" means the machine running the Studio server. In Docker, loopback belongs to the container. Increase the **maximum transcription time** on slow hardware: from 30 s to 10 min, 90 s by default.

## Automatic send or draft

By default, **Send** transcribes and then sends the message. Turn off **Send after transcription** in **Preferences › Tools › Voice messages** to stay in control: the button becomes **Transcribe**, the text is added to the original conversation's draft without being sent, and the cursor moves there so you can complete it before sending.

## Recording

- Use a browser or WebView that supports microphone capture and MediaRecorder. Capture requires a secure context: localhost on the host PC, or HTTPS on a remote device.
- Grant microphone permission when prompted. An application embedding a WebView must also allow audio capture.
- Capture stops after five minutes and waits for Send or Cancel. Uploads are limited to 10 MiB, with one transcription at a time per Studio server.
- After a temporary error (service unavailable, rate limit, timeout, another transcription in progress), the recording is kept: **Retry** sends it again without recording again.
- If the conversation, model, draft or attachments change during transcription, nothing is sent automatically: **Insert text** adds it to the original draft. If the original conversation no longer exists, **Copy text** keeps it.
- Cancel, closing the dialog or leaving the page releases the microphone. Switching to another tab also releases the microphone while recording; a transcription already sent continues and its result waits for you.
- The microphone button always uses the visible editor, including in narrow windows and on mobile.
- Remote consultation clients can neither transcribe nor change this setting. Full-control devices use the same limits and origin checks as the local interface.

## Data

Studio buffers audio in memory and does not save or log recordings or transcription responses. Once inserted or sent, the text follows ordinary draft and history storage. Voice settings are stored in `voice.json` in Studio's data folder; they contain no key. The transcription provider is separate: review Groq's policies or your Whisper server's temporary-file and logging behavior. FFmpeg conversion can create temporary files in the Whisper service.
