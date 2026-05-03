Feature: GET /api/members (FHS-108)
  Real Postgres on :5433 — verifies the route returns every member of
  the resolved tenant with status derived per row, blocks non-members
  with 403, and never leaks rows across tenants.

  Background:
    Given the test Postgres has clean tenants, members, and users tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member

  Scenario: Returns every member of the caller's tenant with derived status
    Given the "khan" tenant has a child member "Iman" with no linked user
    And the "khan" tenant has an adult member "Aisha" linked to a Supabase user
    When the caller GETs /api/members for tenant "khan"
    Then the response status is 200
    And the response lists 3 members
    And the response contains:
      | name  | status    |
      | Iman  | unclaimed |
      | Aisha | active    |

  Scenario: A non-member of the tenant gets 403
    Given a second tenant "smith" exists with no caller membership
    When the caller GETs /api/members for tenant "smith"
    Then the response status is 403

  Scenario: Tenant isolation — listing one tenant never returns rows from another
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has a child member "Zaid" with no linked user
    When the caller GETs /api/members for tenant "khan"
    Then the response status is 200
    And no member named "Zaid" is in the response
