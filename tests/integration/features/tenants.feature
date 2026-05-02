Feature: tenants schema (FHS-2)
  Verifies the tenants table created by migration 0001_tenants against
  real Postgres on :5433 — column defaults, slug uniqueness, slug DNS
  cap, currency length, default UUID generation, status enum, and seed
  idempotency for the frozen SEED_DEFAULT_TENANT_ID.

  Background:
    Given the test Postgres has a clean tenants table

  Scenario: Insert with only required fields applies all column defaults
    When I insert a tenant with slug "alpha" and name "Alpha Family"
    Then the row id is a generated UUID
    And the row status is "active"
    And the row plan is "starter"
    And the row timezone is "UTC"
    And the row currency is "USD"
    And the row has createdAt and updatedAt set

  Scenario: Slug uniqueness — second insert with same slug rejected
    Given a tenant exists with slug "duplicate"
    When I insert a tenant with slug "duplicate" and name "Other Family"
    Then the call rejects with a unique-constraint error
    And exactly 1 row exists with slug "duplicate"

  Scenario: Slug length — 64 characters rejected (DNS label cap is 63)
    When I insert a tenant with a 64-character slug
    Then the call rejects with a length-violation error

  Scenario: Slug length — 63 characters accepted (DNS label cap)
    When I insert a tenant with a 63-character slug
    Then the row is persisted

  Scenario: Currency length — 4 characters rejected
    When I insert a tenant with slug "bad-cur" and currency "USDX"
    Then the call rejects with a length-violation error

  Scenario: Status enum — arbitrary string rejected
    When I insert a tenant with slug "bad-status" and status "wonky"
    Then the call rejects with an invalid-enum error

  Scenario Outline: Status enum — only the three documented values are accepted
    When I insert a tenant with slug "<slug>" and status "<status>"
    Then the row status is "<status>"

    Examples:
      | slug      | status    |
      | s-active  | active    |
      | s-suspend | suspended |
      | s-archive | archived  |

  Scenario: Frozen SEED_DEFAULT_TENANT_ID — re-insert is idempotent via ON CONFLICT
    Given a tenant exists with the frozen SEED_DEFAULT_TENANT_ID and slug "default"
    When I run the seed insert for the default tenant a second time
    Then exactly 1 row exists with slug "default"
    And the row id is the SEED_DEFAULT_TENANT_ID

  Scenario: Two tenants with different slugs coexist
    When I insert a tenant with slug "alpha" and name "Alpha Family"
    And I insert a tenant with slug "beta" and name "Beta Family"
    Then exactly 2 rows exist in tenants
