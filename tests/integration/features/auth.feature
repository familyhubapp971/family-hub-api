Feature: JWT auth middleware (live JWKS over HTTP)
  Real Hono app + real `jose` JWKS fetch over HTTP. Verifies the
  middleware against a network-served JWKS, not the unit-test stub.
  Boundary cases (expired, mismatched issuer, untrusted kid, malformed
  Authorization header) are exercised here so a production regression
  on the verification path fails fast.

  Scenario: Valid token — JWKS fetched and cached
    Given the api uses the trusted JWKS
    And a valid token signed by the trusted key with sub "u-int-1" and email "int@example.com"
    When I GET /me with that bearer token
    Then the response status is 200
    And the body equals { "id": "u-int-1", "email": "int@example.com" }

  Scenario: Two valid calls — second one hits the JWKS cache
    Given the api uses the trusted JWKS
    And a valid token signed by the trusted key with sub "u-int-2" and no email
    And another valid token signed by the trusted key with sub "u-int-3" and no email
    When I GET /me with the first token
    And I GET /me with the second token
    Then both responses have status 200

  Scenario: Token that expired 60 seconds ago returns 401
    Given the api uses the trusted JWKS
    And a token signed by the trusted key that expired 60 seconds ago
    When I GET /me with that bearer token
    Then the response status is 401
    And the body equals { "error": "unauthorized" }

  Scenario: Token expired by 1 second still returns 401 (expiry boundary)
    Given the api uses the trusted JWKS
    And a token signed by the trusted key that expired 1 second ago
    When I GET /me with that bearer token
    Then the response status is 401

  Scenario: Token issued by an untrusted issuer returns 401
    Given the api uses the trusted JWKS
    And a token signed by the trusted key but issued by "https://attacker.example/auth/v1"
    When I GET /me with that bearer token
    Then the response status is 401

  Scenario: Missing Authorization header returns 401
    Given the api uses the trusted JWKS
    When I GET /me with no Authorization header
    Then the response status is 401

  Scenario: Token signed by an untrusted key with the trusted kid returns 401
    Given the api uses the trusted JWKS
    And a token signed by an attacker key but stamped with the trusted kid
    When I GET /me with that bearer token
    Then the response status is 401

  Scenario: Token with an unknown kid returns 401
    Given the api uses the trusted JWKS
    And a token signed by a different key with kid "untrusted-kid"
    When I GET /me with that bearer token
    Then the response status is 401

  Scenario Outline: Malformed Authorization headers return 401
    Given the api uses the trusted JWKS
    When I GET /me with the Authorization header set to "<header>"
    Then the response status is 401

    Examples:
      | header                |
      | Bearer                |
      | Token abc.def.ghi     |
      | NotEvenClose          |
      |                       |

  Scenario: /health is public — passes without a token
    Given the api uses the trusted JWKS
    When I GET /health on the auth-test app with no Authorization header
    Then the response status is 200

  Scenario: JWKS unreachable — fail-closed 401, not 500
    Given the api JWKS URL points at a dead port
    And a valid token signed by the trusted key with sub "u-int-9" and no email
    When I GET /me with that bearer token
    Then the response status is 401

  Scenario: Oversized token (10 KB email claim) — verifies, doesn't crash
    Given the api uses the trusted JWKS
    And a valid token signed by the trusted key with a 10 KB email claim
    When I GET /me with that bearer token
    Then the response status is 200
    And the api is still responsive on /health
