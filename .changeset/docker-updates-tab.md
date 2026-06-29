---
"@jmfederico/pi-web": patch
---

Expose Docker-aware PI WEB status, update, and restart commands in the Updates panel through the canonical `pi-web-docker` command, including explicit `pi-web-docker --dev ...` commands for Docker development runtimes, and harden production and development Docker workflows around generated Compose assets, Compose project-name isolation, clearer checkout/runtime guidance, root-safety checks, UID/GID preservation, and detached helper execution.
