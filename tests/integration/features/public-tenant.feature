Feature: POST /api/public/tenant (FHS-25)
  Real Postgres on :5433 — verifies the route inserts a tenants row +
  a members row linking the authenticated user, returns 409 on slug
  collision, and rolls back nothing on the happy path (both rows
  persist).

  Background:
    Given the test Postgres has clean tenants and members tables
    And a users mirror row exists for the test user

  Scenario: Happy path — creates tenant and member, returns 201
    When I POST to /api/public/tenant with familyName "Khan" displayName "Sarah" slug "khan"
    Then the response status is 201
    And the response body has a tenant with slug "khan"
    And exactly 1 row exists in tenants with slug "khan"
    And exactly 1 row exists in members with displayName "Sarah" and role "adult"

  Scenario: Slug already taken — returns 409 and inserts nothing
    Given a tenant exists with slug "khan"
    When I POST to /api/public/tenant with familyName "Khan" displayName "Sarah" slug "khan"
    Then the response status is 409
    And exactly 1 row exists in tenants with slug "khan"
