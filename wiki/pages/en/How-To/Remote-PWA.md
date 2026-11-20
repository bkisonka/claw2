# How-To: remote PWA

Access the same chats from your phone over HTTPS. iOS requires a trusted certificate.

## Prepare on desktop

1. Cabinet → **Settings → Remote access (PWA / HTTPS)**.
2. Set a **PWA access token** (“Generate”) and save. Copy the token — you will need it on the phone.
3. Enable DuckDNS: domain and token from duckdns.org; “Update IP” if needed.
4. Enable LE certificate prep, set email; “Get / renew certificate”.
5. Enable “Listen HTTPS”, pick a port (often **8443** if 443 is busy or needs privileges), UPnP on a home router if needed.
6. **Open HTTPS port** (from settings or tray). Test from LTE, not home Wi‑Fi.

Without an access token the public API stays closed — that is intentional.

## On the phone

1. Safari: `https://your-domain.duckdns.org:port/pwa/` (include the port if not 443).
2. Enter the **same access token**.
3. Share → **Add to Home Screen** for an app-like mode.

Chats sync with desktop (single `default` user on the desktop gateway).

## Common failures

| Symptom | Check |
|---------|--------|
| Site won’t open | Is HTTPS listening? UPnP/port forward? DuckDNS IP? |
| Token form / 401 | Correct token saved in desktop settings |
| Old UI | Refresh `/pwa/`, clear SW / reinstall the PWA |

## See also

- [Settings](../Settings.md)
- [Voice](Voice.md)
