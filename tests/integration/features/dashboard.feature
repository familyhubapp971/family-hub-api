Feature: GET /api/dashboard/today (FHS-228)
  Real Postgres on :5433 — verifies the home-tab payload bundles
  greeting, today's date, the family roster and counts (members /
  habits / rewards), blocks non-members with 403, and never leaks
  rows across tenants.

  Background:
    Given the test Postgres has clean tenants, members, habits, rewards, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: Returns greeting, members, and counts for the caller's tenant
    Given the "khan" tenant has a child member "Iman" with no linked user
    And the "khan" tenant has 2 starter habits and 1 starter rewards
    And the "khan" tenant has 1 archived habit and 1 archived reward
    When the caller GETs /api/dashboard/today for tenant "khan"
    Then the response status is 200
    And the response includes today's date in YYYY-MM-DD form
    And the response counts are:
      | label   | n |
      | members | 2 |
      | habits  | 2 |
      | rewards | 1 |
    And the response lists 2 members
    And the member named "Iman" appears in the response

  Scenario: A non-member of the tenant gets 403
    Given a second tenant "smith" exists with no caller membership
    When the caller GETs /api/dashboard/today for tenant "smith"
    Then the response status is 403

  Scenario: Tenant isolation — counts and members never leak across tenants
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has a child member "Zaid" with no linked user
    And the "smith" tenant has 4 starter habits and 2 starter rewards
    When the caller GETs /api/dashboard/today for tenant "khan"
    Then the response status is 200
    And the response counts are:
      | label   | n |
      | members | 1 |
      | habits  | 0 |
      | rewards | 0 |
    And no member named "Zaid" is in the response
