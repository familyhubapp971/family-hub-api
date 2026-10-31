# Shared rules (`@familyhub/shared`)

The common rules the server, the web site and the phone app all use:
request and response shapes, roles, money and week helpers. The server
owns them because it enforces them.

## Install it (web site or phone app)

Install straight from this repo, pinned to a version label. The repo is
public, so no key is needed:

```json
"@familyhub/shared": "github:familyhubapp971/family-hub-api#shared-rules-v0.1.0&path:shared-rules"
```

## Release a new version

1. Change the rules here and merge to `staging`, with tests passing.
2. Raise `version` in `shared-rules/package.json` (0.1.0 → 0.2.0 for a
   new rule, 1.0.0-style jumps only for a breaking change).
3. After that merges, add a version label on the merge commit:
   `git tag shared-rules-v0.2.0 <commit> && git push origin shared-rules-v0.2.0`.
4. In the web site and the app, change the label in the line above and
   run `pnpm install`.

Never move or reuse a label once pushed: apps pinned to it must keep
getting exactly the same rules.
