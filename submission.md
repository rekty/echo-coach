### App Name

Echo Coach

### App Description

Record a line or a five-note melody: it transcribes your speech, measures your pitch in cents, and answers with three coaching tips read aloud, all from Pollinations models.

### App URL

https://rekty.github.io/echo-coach/

### GitHub Repository URL

https://github.com/rekty/echo-coach

### App Category

video_audio

### Platform

web

### App Language

en

### Screenshot

![Echo Coach practice screen](https://raw.githubusercontent.com/rekty/echo-coach/master/screenshot.png)

### Quest

#20022

### Sign-in clarification

Visitors do not supply or create a key. The only sign-in path is the official drop-in button, and the app has no key input field:

```html
<script defer src="https://cdn.jsdelivr.net/npm/@pollinations/ui@0.1.0-alpha.20/dist/connect.js"></script>
<polli-connect budget="5" expiry="7"></polli-connect>
```

Clicking **Connect** opens Pollinations Connect — the `/authorize` consent screen on `enter.pollinations.ai`. The visitor signs in with their Pollinations account, sees the app's origin, and approves a budget cap (5 pollen) and a 7-day expiry for this app. The element runs that OAuth flow (PKCE) against the consent screen and then exposes the resulting budget-scoped app key on its `apiKey` property.

`app.js` reads that property from the `change` event, keeps it in memory for the session only, and sends it as `Authorization: Bearer …` to `gen.pollinations.ai`. No personal key is requested, pasted or stored, and there is no backend of ours that could see the key or a recording.

The README now states this explicitly: https://github.com/rekty/echo-coach#sign-in-pollinations-connect
