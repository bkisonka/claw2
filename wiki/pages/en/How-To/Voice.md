# How-To: voice

## Desktop

In chat — the mic button (push-to-talk): hold, speak, release. Audio goes to STT; chat receives **text**. The **Voice** section (STT) must be configured.

Optionally TTS speaks model replies when enabled in settings/channel.

## PWA

Same idea: hold the mic → release. On successful transcription only text is sent (no audio file in uploads — otherwise the model gets distracted “processing the wav”).

If STT fails — an error message; retry or type instead.

Allow the microphone for the site/PWA once in the OS.

## Photos and video in PWA

Via the paperclip: file / photo / video — attachment for the model (camera uses the system iOS/Android picker).

## See also

- [Settings](../Settings.md)
- [Remote PWA](Remote-PWA.md)
