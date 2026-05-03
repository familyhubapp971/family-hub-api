#!/usr/bin/env python3
"""Configure the Google OAuth provider on a Supabase project (FHS-248).

Hits the Supabase Management API at /v1/projects/{ref}/config/auth to:
  - enable the Google provider (external_google_enabled = true)
  - set client_id / client_secret from .env.local
  - leave skip_nonce_check at its default (false)

Idempotent: re-running with the same values is a no-op.

Usage:
    set -a; source .env.local; set +a
    python3 scripts/configure-google-oauth.py            # configure staging
    python3 scripts/configure-google-oauth.py --check    # diff-only, no PATCH
    python3 scripts/configure-google-oauth.py --project production
                                                          # configure production

Required env vars:
    SUPABASE_ACCESS_TOKEN     personal access token for the Management API
    GOOGLE_OAUTH_CLIENT_ID
    GOOGLE_OAUTH_CLIENT_SECRET

Standard library only.

See:
- ADR 0008 — Supabase environments (staging vs production projects)
- ADR 0011 — Magic-link + Google OAuth parent auth
- documents/technical/google-oauth-setup.md — manual click-by-click runbook
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# Same project refs used by apply-supabase-email-templates.py — keep
# in sync if either file is touched.
PROJECTS: dict[str, str] = {
    "staging": "maolytpqazmykjzdybtj",
    "production": "bqghmbkoxjompuxixexn",
}

# Fields the script writes / reads on /config/auth. Names mirror the
# Supabase API exactly (see https://api.supabase.com/api/v1#/auth).
FIELDS = (
    "external_google_enabled",
    "external_google_client_id",
    "external_google_secret",
    "external_google_skip_nonce_check",
)


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(f"error: env var {name} is required (source .env.local first)")
    return v


def auth_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        # Supabase's CF layer rejects the default python-urllib UA.
        "User-Agent": "family-hub-app/configure-google-oauth",
    }


def http(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=auth_headers(token))
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode() or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        body_txt = exc.read().decode("utf-8", errors="replace")
        raise HttpError(exc.code, f"{method} {url} → {exc.code}: {body_txt}") from exc


def get_auth_config(project_ref: str, token: str) -> dict:
    return http("GET", f"https://api.supabase.com/v1/projects/{project_ref}/config/auth", token)


def patch_auth_config(project_ref: str, token: str, body: dict) -> dict:
    return http(
        "PATCH",
        f"https://api.supabase.com/v1/projects/{project_ref}/config/auth",
        token,
        body,
    )


def diff(current: dict, desired: dict) -> dict:
    """Return only the fields whose desired value differs from current.

    Secret fields are write-only on the Supabase API: GET masks them as
    None/empty/"***". We never include them in the diff — the caller
    can pass --rotate-secret to force a rewrite when needed.
    """
    out: dict = {}
    for k, v in desired.items():
        if k.endswith("_secret"):
            # Always skip — secrets cannot be diffed against a masked value.
            continue
        if current.get(k) != v:
            out[k] = v
    return out


def configure(project: str, *, check_only: bool, rotate_secret: bool) -> int:
    if project not in PROJECTS:
        sys.exit(f"error: unknown project {project!r} (expected one of {list(PROJECTS)})")

    token = env("SUPABASE_ACCESS_TOKEN")
    client_id = env("GOOGLE_OAUTH_CLIENT_ID")
    client_secret = env("GOOGLE_OAUTH_CLIENT_SECRET")
    project_ref = PROJECTS[project]

    desired = {
        "external_google_enabled": True,
        "external_google_client_id": client_id,
        "external_google_secret": client_secret,
        "external_google_skip_nonce_check": False,
    }

    print(f"[{project}] reading current auth config…")
    current = get_auth_config(project_ref, token)

    # Print only the fields we care about, with secret masked.
    snapshot = {k: current.get(k) for k in FIELDS}
    snapshot_safe = {**snapshot}
    if snapshot_safe.get("external_google_secret"):
        snapshot_safe["external_google_secret"] = "***"
    print(f"[{project}] current: {json.dumps(snapshot_safe, indent=2)}")

    delta = diff(snapshot, desired)
    # rotate-secret injection happens BEFORE the empty-check + print so
    # `--check --rotate-secret` shows the queued secret rewrite rather
    # than reporting "nothing to do".
    if rotate_secret:
        delta["external_google_secret"] = client_secret

    if not delta:
        print(f"[{project}] ✓ already up-to-date — nothing to do")
        return 0

    safe_delta = {**delta}
    if "external_google_secret" in safe_delta:
        safe_delta["external_google_secret"] = "***"
    print(f"[{project}] {'would patch' if check_only else 'patching'}: {json.dumps(safe_delta, indent=2)}")

    if check_only:
        return 1

    patch_auth_config(project_ref, token, delta)

    # Verify by re-reading. `diff()` already skips secret fields (they
    # cannot be verified since GET masks them), so this only catches
    # drift on the non-secret fields.
    after = get_auth_config(project_ref, token)
    after_snap = {k: after.get(k) for k in FIELDS}
    mismatched = diff(after_snap, desired)
    if mismatched:
        sys.exit(f"[{project}] ✗ post-patch verify failed: {json.dumps(mismatched, indent=2)}")

    print(f"[{project}] ✓ Google OAuth provider configured")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument(
        "--project",
        default="staging",
        choices=sorted(PROJECTS),
        help="which Supabase project to configure (default: staging)",
    )
    ap.add_argument(
        "--check",
        action="store_true",
        help="show the diff but do not PATCH",
    )
    ap.add_argument(
        "--rotate-secret",
        action="store_true",
        help=(
            "force a secret PATCH even if the API doesn't echo a current value "
            "(use after rotating the Google OAuth client secret)"
        ),
    )
    args = ap.parse_args()
    return configure(args.project, check_only=args.check, rotate_secret=args.rotate_secret)


if __name__ == "__main__":
    sys.exit(main())
