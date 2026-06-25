---
"@jmfederico/pi-web": patch
---

Fix `pi-web doctor` "can find npm/pi" checks on fish. The `--version` check
wrapped the version command in a POSIX subshell `(cmd --version 2>&1 || true)`,
which fish parses as a command substitution in command position and rejects
(`command substitutions not allowed in command position`), producing a false
negative. Emit fish's `begin; ...; end` grouping when the service shell is fish.
