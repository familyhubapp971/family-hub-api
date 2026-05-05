Feature: POST /api/auth/kid-pin (FHS-236)
  Real Postgres on :5433 — verifies the kid-PIN auth path end-to-end:
  bcrypt hash stored on insert + verified on login + a child-scoped
  JWT issued with the right claims.

  Background:
    Given the test Postgres has clean tenants and members tables

  Scenario: Valid PIN returns 200 with a JWT carrying scope=child
    Given a tenant "khan" exists with a kid member "Iman" with PIN "1234"
    When the kid POSTs the correct PIN for "Iman" in tenant "khan"
    Then the response status is 200
    And the response token decodes with scope "child" and the member's id

  Scenario: Wrong PIN returns 401 with a generic envelope
    Given a tenant "khan" exists with a kid member "Iman" with PIN "1234"
    When the kid POSTs the wrong PIN "9999" for "Iman" in tenant "khan"
    Then the response status is 401

  Scenario: A non-kid member with no PIN returns 401 (cannot enumerate eligibility)
    Given a tenant "khan" exists with an adult member "Sarah" who has no PIN
    When the kid POSTs PIN "1234" for "Sarah" in tenant "khan"
    Then the response status is 401
