# Supabase infra notes

Operator notes for our two Supabase projects (per
[ADR 0008](../../documents/decisions/0008-supabase-environments.md)). The
projects themselves were provisioned in FHS-187; auth-config knobs
(email templates, providers) and seed accounts live here.

## E2E test user (FHS-196)

A dedicated synthetic account on the **staging** Supabase project that
the Playwright login flow signs in as. Never use it for anything else.

- Project: `maolytpqazmykjzdybtj` (Family Hub Staging)
- Email: `e2e@familyhub.test`
- User id: `d012e8e7-95f3-4bbe-9269-0d4c00a4893e`
- Password: rotated random; lives in `.env.local` (local) and the repo
  GitHub Actions secrets (CI) as `E2E_USER_EMAIL` / `E2E_USER_PASSWORD`.

### Create or rotate

```bash
set -a; source .env.local; set +a
python3 - <<'PY'
import os, json, urllib.request, urllib.error, secrets
URL = os.environ['SUPABASE_URL_STAGING'].rstrip('/')
KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY_STAGING']
EMAIL = 'e2e@familyhub.test'
NEW_PW = secrets.token_urlsafe(32)
H = {'apikey': KEY, 'Authorization': f'Bearer {KEY}',
     'Content-Type': 'application/json', 'Accept': 'application/json'}
# Look up existing user id, then PUT a new password.
list_req = urllib.request.Request(
    f'{URL}/auth/v1/admin/users?per_page=200', headers=H)
users = json.loads(urllib.request.urlopen(list_req).read())['users']
match = next((u for u in users if u['email'] == EMAIL), None)
if not match:
    raise SystemExit(f'{EMAIL} not found — create via the same admin endpoint')
put_req = urllib.request.Request(
    f'{URL}/auth/v1/admin/users/{match["id"]}',
    data=json.dumps({'password': NEW_PW, 'email_confirm': True}).encode(),
    method='PUT', headers=H)
urllib.request.urlopen(put_req).read()
print('Email:', EMAIL); print('Password:', NEW_PW)
PY
```

After rotation: paste the new password into `.env.local` AND update the
`E2E_USER_PASSWORD` GitHub Actions secret (Settings → Secrets and
variables → Actions). Both must change in lockstep or CI fails.

### Why a dedicated account, not a per-run signup

We do per-run signups in the FHS-193 flow (`Visitor signs up with
valid credentials`) — those create fresh `e2e+<timestamp>@familyhub.test`
addresses every run. Two reasons that pattern is wrong for the /me flow:

1. The user-mirror upsert needs to round-trip Postgres on first request
   for the assertion to be meaningful. A brand-new signup hasn't
   confirmed their email yet, so the JWT is missing on first call.
2. A confirmed account with a stable id makes the test cheaper to write
   (no email-link click, no confirmation polling).
