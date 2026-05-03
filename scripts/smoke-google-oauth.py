#!/usr/bin/env python3
"""Smoke-test Google OAuth provider on a Supabase project (FHS-248).

Hits Supabase's `/auth/v1/authorize?provider=google` with a junk
redirect_to and asserts the response is a 302 to accounts.google.com.
That confirms the provider is enabled and the client_id is wired.

What we DO NOT test here:
  - whether the Google client_secret is valid (impossible without a
    full OAuth round-trip + a real Google account)
  - whether the redirect URI is whitelisted in the Google Cloud
    console (only fails when a real user clicks through)

For a full round-trip check, sign up via /signup and click
"Continue with Google" against the staging deployment.

Usage:
    set -a; source .env.local; set +a
    python3 scripts/smoke-google-oauth.py             # checks staging
    python3 scripts/smoke-google-oauth.py --project production

Required env vars (one set, depending on --project):
    SUPABASE_URL_STAGING + SUPABASE_ANON_KEY_STAGING
    SUPABASE_URL_PRODUCTION + SUPABASE_ANON_KEY_PRODUCTION

Standard library only.
"""

import argparse
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(f"error: env var {name} is required (source .env.local first)")
    return v


def smoke(project: str) -> int:
    suffix = project.upper()
    supabase_url = env(f"SUPABASE_URL_{suffix}").rstrip("/")
    anon_key = env(f"SUPABASE_ANON_KEY_{suffix}")

    # The /authorize endpoint expects apikey AND a redirect_to that
    # ends up echoed back in the Google state. Anything that round-
    # trips will do — the smoke test cares about Google's Location
    # header, not the redirect target.
    qs = urllib.parse.urlencode(
        {
            "provider": "google",
            "redirect_to": f"{supabase_url}/auth/v1/callback",
            "apikey": anon_key,
        }
    )
    url = f"{supabase_url}/auth/v1/authorize?{qs}"

    print(f"[{project}] GET {url[:80]}…")

    req = urllib.request.Request(
        url,
        headers={
            "apikey": anon_key,
            "User-Agent": "family-hub-app/smoke-google-oauth",
        },
    )

    # Don't follow the redirect — we want to inspect the Location header.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_, **__):  # noqa: D401
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=15) as resp:
            status = resp.getcode()
            location = resp.headers.get("Location") or ""
            body = resp.read(200).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        location = exc.headers.get("Location") or ""
        body = exc.read(200).decode("utf-8", errors="replace")

    if status != 302:
        sys.exit(f"[{project}] ✗ expected 302, got {status}: {body}")
    if "accounts.google.com" not in location:
        sys.exit(f"[{project}] ✗ Location did not point at Google: {location[:200]}")

    # Sanity-check the client_id is present in the redirect URL —
    # otherwise Supabase silently used an empty value.
    parsed = urllib.parse.urlparse(location)
    qs_params = urllib.parse.parse_qs(parsed.query)
    client_id = (qs_params.get("client_id") or [""])[0]
    if not client_id or not client_id.endswith(".apps.googleusercontent.com"):
        sys.exit(f"[{project}] ✗ Google URL missing a valid client_id: {client_id!r}")

    print(f"[{project}] ✓ provider responds with redirect to {parsed.netloc}{parsed.path}")
    print(f"[{project}] ✓ client_id = {client_id}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument(
        "--project",
        default="staging",
        choices=("staging", "production"),
        help="which Supabase project to smoke-test (default: staging)",
    )
    args = ap.parse_args()
    return smoke(args.project)


if __name__ == "__main__":
    sys.exit(main())
