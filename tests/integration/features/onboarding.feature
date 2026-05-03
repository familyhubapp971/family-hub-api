Feature: POST /api/onboarding/complete (FHS-37)
  Real Postgres on :5433 — verifies the route flips tenant.onboarding_completed,
  inserts the wizard's members in one transaction, and never touches a
  different tenant's flag (cross-tenant isolation).

  Background:
    Given the test Postgres has clean tenants, members, and onboarding state
    And a users mirror row exists for the test admin
    And tenants "khan" and "smith" exist with the admin as a member of "khan"

  Scenario: Happy path — admin completes onboarding for their tenant
    When the admin POSTs onboarding-complete for tenant "khan" with timezone "Asia/Dubai", currency "AED", and 2 members
    Then the response status is 200
    And tenant "khan" has onboarding_completed = true
    And tenant "khan" has 3 members in total
    And tenant "smith" still has onboarding_completed = false

  Scenario: Idempotent — second submit returns 200 without duplicating members
    Given the admin has already completed onboarding for tenant "khan" with 2 members
    When the admin POSTs onboarding-complete for tenant "khan" with timezone "Asia/Dubai", currency "AED", and 2 members
    Then the response status is 200
    And tenant "khan" has 3 members in total
