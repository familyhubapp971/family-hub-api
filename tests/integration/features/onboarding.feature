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
    # FHS-40 — starter content seeded under tenant "khan", and only "khan".
    And tenant "khan" has 5 habits seeded
    And tenant "khan" has 3 rewards seeded
    And tenant "smith" has 0 habits seeded

  Scenario: Idempotent — second submit returns 200 without duplicating members or seed
    Given the admin has already completed onboarding for tenant "khan" with 2 members
    When the admin POSTs onboarding-complete for tenant "khan" with timezone "Asia/Dubai", currency "AED", and 2 members
    Then the response status is 200
    And tenant "khan" has 3 members in total
    # FHS-40 — re-submit must NOT re-seed habits/rewards.
    And tenant "khan" has 5 habits seeded
    And tenant "khan" has 3 rewards seeded

  # FHS-41 — atomicity. If any step inside the onboarding transaction
  # throws, the whole submission must roll back: no members inserted,
  # no seeded content, tenant flag unchanged. Simulated by stubbing the
  # seed helper to reject mid-transaction.
  Scenario: Partial-failure rollback — seed throws, nothing commits
    Given the seed step will throw on the next submission
    When the admin POSTs onboarding-complete for tenant "khan" with timezone "Asia/Dubai", currency "AED", and 2 members
    Then the response status is 500
    And tenant "khan" still has onboarding_completed = false
    And tenant "khan" has 1 member in total
    And tenant "khan" has 0 habits seeded
    And tenant "khan" has 0 rewards seeded
