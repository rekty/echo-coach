# Echo Coach

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

Practise speaking or singing in the browser and get coached on the take you just recorded.

- **Speak** — read a phrase, see the transcript, see which words the transcriber missed, and hear three
  things to fix from a text model.
- **Sing** — sing a five-note melody while your pitch is tracked live, then see how many cents each note
  landed away from the target and what to adjust.

No build step, no backend, no accounts of its own. Everything runs in the browser, and every request is
paid from the listener's own Pollinations balance through the drop-in Connect button.

## Why it is a Pollinations app

| Job | Model | Cost |
| --- | --- | --- |
| Transcribe the take | `microsoft/mai-transcribe-2` | free |
| Coach the take | `openai/gpt-5.4-nano` | free |
| Read the coaching out loud | `openai/tts-1` (voice `alloy`) | free |

Paid models stay opt-in: nothing in the app needs one. Pitch tracking for the sing mode is local DSP
(autocorrelation), so it costs nothing and works offline.

## Sign-in (Bring Your Own Pollen)

The header hosts the official drop-in button:

```html
<script defer src="https://cdn.jsdelivr.net/npm/@pollinations/ui@0.1.0-alpha.20/dist/connect.js"></script>
<polli-connect budget="5" expiry="7"></polli-connect>
```

`app.js` reads `apiKey` from the element's `change` event and sends it as `Authorization: Bearer sk_…`.
The key lives in the element's own storage; this app never writes it anywhere else and there is no server
that could see a recording.

## How a take flows

1. `getUserMedia` records the take with `MediaRecorder`.
2. **Speak:** the clip is decoded and re-encoded in the browser as 16 kHz mono WAV, because the
   transcription endpoint rejects the WebM/Opus that browsers record. It is posted to
   `POST /v1/audio/transcriptions` with `response_format=verbose_json`, then the target phrase and the
   transcript are aligned with a longest-common-subsequence diff to score word accuracy.
   **Sing:** every 40 ms the analyser buffer goes through an autocorrelation pitch detector; the median
   pitch inside each note window gives the cents error.
3. The measurement (never the audio) goes to `POST /v1/chat/completions` for three coaching tips.
4. "Speak it" sends those tips to `POST /v1/audio/speech` and plays the result.

## Run it locally

```sh
npx serve .
# or
python -m http.server 8000
```

Open the page on `localhost`, click **Connect**, approve a budget, and record. Browsers only expose the
microphone on `localhost` or HTTPS, so opening the file directly from disk will not record.

## Files

```
index.html   layout, connect button, both practice modes
styles.css   dark UI, gradient accent
app.js       recorder, WAV encoder, transcription, pitch detection, coaching, TTS
```

## Notes

- Only the transcription request carries audio, and it goes straight to `gen.pollinations.ai`.
- Nothing is logged, stored or shared; there is no analytics.
- The drop-in button shows your hostname on the consent screen. Adding an App Key would put an app name
  there and earn from usage.
