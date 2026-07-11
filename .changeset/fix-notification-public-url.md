---
"@jmfederico/pi-web": patch
---

Fix push notification links to use the configured public URL (`PI_WEB_PUBLIC_URL`) instead of resolving relative paths against localhost, so notification clicks always land on the publicly-reachable hostname.