#!/usr/bin/env python3
"""Apply branded email templates to both Supabase projects (FHS-188).

Reads HTML files from `apps/api/auth/email-templates/`, parses the
`<!-- subject: ... -->` directive at the top of each, and PATCHes
`/v1/projects/{ref}/config/auth` for both staging and production.
Idempotent: re-running with the same files is a no-op for fields that
already match.

Usage:
    set -a; source .env.local; set +a
    python3 scripts/apply-supabase-email-templates.py            # apply + verify both projects
    python3 scripts/apply-supabase-email-templates.py --check    # diff-only, no PATCH
    python3 scripts/apply-supabase-email-templates.py --project staging   # apply to one only

Reads env vars: SUPABASE_ACCESS_TOKEN. Standard library only.

See [ADR 0008](../docs/decisions/0008-supabase-environments.md) for the
two-project topology this script targets.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = REPO_ROOT / "apps" / "api" / "auth" / "email-templates"

# Maps template filename → (subject_field, content_field) on /config/auth.
# Order = order they're applied; doesn't matter functionally but keeps
# logs predictable.
TEMPLATES: list[tuple[str, str, str]] = [
    ("confirmation.html",     "mailer_subjects_confirmation",     "mailer_templates_confirmation_content"),
    ("magic_link.html",       "mailer_subjects_magic_link",       "mailer_templates_magic_link_content"),
    ("invite.html",           "mailer_subjects_invite",           "mailer_templates_invite_content"),
    ("recovery.html",         "mailer_subjects_recovery",         "mailer_templates_recovery_content"),
    ("email_change.html",     "mailer_subjects_email_change",     "mailer_templates_email_change_content"),
    ("reauthentication.html", "mailer_subjects_reauthentication", "mailer_templates_reauthentication_content"),
]

PROJECTS: dict[str, str] = {
    "staging":    "maolytpqazmykjzdybtj",
    "production": "bqghmbkoxjompuxixexn",
}

SUBJECT_RE = re.compile(r"<!--\s*subject:\s*(.+?)\s*-->", re.IGNORECASE)


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(f"error: env var {name} is required (source .env.local first)")
    return v


def auth_headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        # Supabase's Cloudflare layer rejects requests with the default
        # python-urllib UA. A static, identifiable UA is enough to pass.
        "User-Agent": "family-hub-app/apply-supabase-email-templates",
    }


def http(method: str, url: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=auth_headers(token))
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read().decode()
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        raise HttpError(e.code, f"HTTP {e.code} on {method} {url}\n{e.read().decode()}") from e


def parse_template(path: Path) -> tuple[str, str]:
    raw = path.read_text(encoding="utf-8")
    m = SUBJECT_RE.search(raw)
    if not m:
        sys.exit(f"error: {path.name} is missing a `<!-- subject: ... -->` directive")
    subject = m.group(1).strip()
    # Strip the subject comment from the body so the email content stays clean.
    body = SUBJECT_RE.sub("", raw, count=1).lstrip()
    return subject, body


def build_payload() -> dict[str, str]:
    payload: dict[str, str] = {}
    for filename, subj_field, body_field in TEMPLATES:
        subject, body = parse_template(TEMPLATE_DIR / filename)
        payload[subj_field] = subject
        payload[body_field] = body
    return payload


def get_auth_config(ref: str, token: str) -> dict:
    return http("GET", f"https://api.supabase.com/v1/projects/{ref}/config/auth", token)


def patch_auth_config(ref: str, token: str, payload: dict) -> dict:
    return http(
        "PATCH",
        f"https://api.supabase.com/v1/projects/{ref}/config/auth",
        token,
        body=payload,
    )


def diff_fields(current: dict, desired: dict) -> list[str]:
    """Return the list of fields where current != desired."""
    return [k for k, v in desired.items() if current.get(k) != v]


def apply_to(ref: str, token: str, payload: dict, *, dry_run: bool) -> tuple[int, int]:
    """Returns (changed_count, total_count)."""
    print(f"\n[{ref}] fetching current /config/auth...")
    current = get_auth_config(ref, token)
    changed = diff_fields(current, payload)
    total = len(payload)
    print(f"[{ref}] {len(changed)}/{total} fields differ from desired state")
    for k in changed:
        # Truncate long values for readability.
        cur = (current.get(k) or "")[:60].replace("\n", " ")
        new = payload[k][:60].replace("\n", " ")
        print(f"  - {k}: {cur!r} -> {new!r}")

    if not changed:
        print(f"[{ref}] already in sync — no PATCH needed")
        return 0, total

    if dry_run:
        print(f"[{ref}] --check set, skipping PATCH")
        return len(changed), total

    print(f"[{ref}] PATCHing {len(changed)} fields...")
    patch_auth_config(ref, token, {k: payload[k] for k in changed})

    # Verify by re-fetching and confirming round-trip.
    verify = get_auth_config(ref, token)
    still_diff = diff_fields(verify, payload)
    if still_diff:
        sys.exit(f"[{ref}] ERROR: {len(still_diff)} fields still differ after PATCH: {still_diff}")
    print(f"[{ref}] verified — all {total} fields match desired state")
    return len(changed), total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="Show diff against current Supabase state without PATCHing.",
    )
    parser.add_argument(
        "--project",
        choices=list(PROJECTS) + ["both"],
        default="both",
        help="Which Supabase project to target. Defaults to both.",
    )
    args = parser.parse_args()

    token = env("SUPABASE_ACCESS_TOKEN")
    if not TEMPLATE_DIR.is_dir():
        sys.exit(f"error: template directory not found: {TEMPLATE_DIR}")

    print(f"Loading templates from {TEMPLATE_DIR.relative_to(REPO_ROOT)}")
    payload = build_payload()
    print(f"  {len(payload)} fields ({len(TEMPLATES)} templates × subject+body)")

    targets = list(PROJECTS) if args.project == "both" else [args.project]
    summary: list[tuple[str, int, int]] = []
    for name in targets:
        ref = PROJECTS[name]
        changed, total = apply_to(ref, token, payload, dry_run=args.check)
        summary.append((name, changed, total))

    print("\nSummary:")
    for name, changed, total in summary:
        verb = "would change" if args.check else "changed"
        print(f"  {name:11s} {verb} {changed}/{total} fields")


if __name__ == "__main__":
    main()
