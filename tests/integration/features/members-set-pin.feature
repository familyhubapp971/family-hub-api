Feature: PUT/DELETE /api/members/:id/pin (FHS-252)
  Real Postgres on :5433, admins/adults can set or clear a kid's
  4-digit PIN. Without this, the kid-login flow shipped in
  FHS-235..FHS-238 is unreachable from product (kids can't log in
  unless someone runs SQL by hand).

  Background:
    Given the test Postgres has clean tenants, members, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: Admin sets a fresh PIN on a kid member: verifies via /api/auth/kid-pin
    Given a kid member "Iman" exists in tenant "khan" with no PIN
    When the admin PUTs PIN "1234" for "Iman"
    Then the response status is 200
    And the response body marks "Iman" as isChild "true" and hasPin "true"
    And kid-login with PIN "1234" for "Iman" succeeds

  Scenario: Admin resets an existing PIN: old PIN stops working
    Given a kid member "Iman" exists in tenant "khan" with PIN "1234"
    When the admin PUTs PIN "5678" for "Iman"
    Then the response status is 200
    And kid-login with PIN "1234" for "Iman" fails
    And kid-login with PIN "5678" for "Iman" succeeds

  Scenario: Admin DELETEs a kid's PIN: kid is no longer eligible
    Given a kid member "Iman" exists in tenant "khan" with PIN "1234"
    When the admin DELETEs the PIN for "Iman"
    Then the response status is 200
    And the response body marks "Iman" as isChild "false" and hasPin "false"
    And kid-login with PIN "1234" for "Iman" fails

  Scenario: Adult member can also set a PIN (not just admin)
    Given an adult member "Yusuf" who is the caller of tenant "khan"
    And a kid member "Iman" exists in tenant "khan" with no PIN
    When the adult PUTs PIN "4242" for "Iman"
    Then the response status is 200

  Scenario: Cross-tenant attempt is rejected with 404
    Given a tenant "patel" exists with a kid member "Riya" with PIN "1111"
    When the admin of "khan" PUTs PIN "9999" for "Riya"
    Then the response status is 404

  Scenario: Invalid PIN format is rejected with 400
    Given a kid member "Iman" exists in tenant "khan" with no PIN
    When the admin PUTs PIN "abcd" for "Iman"
    Then the response status is 400

  Scenario: Setting a PIN on a non-child/non-teen target is rejected with 403
    Given an existing adult member "Yusuf" of tenant "khan"
    When the admin PUTs PIN "1234" for "Yusuf"
    Then the response status is 403
