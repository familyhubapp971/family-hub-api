Feature: RLS enforcement (FHS-348)

  Row-Level Security is enabled and forced on every tenant-scoped table, keyed
  on the per-request app.current_tenant. The database returns only the current
  family's rows (even without a tenant_id filter in the query), rejects writes
  into another family, and returns nothing when no family is pinned.

  Background:
    Given two families "A" and "B" each seeded with a member as the owner

  Scenario: every tenant-scoped table has RLS enabled, forced, and policied
    Then every tenant-scoped table has RLS enabled and forced
    And every tenant-scoped table has the tenant_isolation policy

  Scenario: the limited role sees only its own family rows, unfiltered
    When app_runtime pinned to family "A" selects all members with no filter
    Then it sees only family "A" rows

  Scenario: the limited role with no family pinned sees nothing
    When app_runtime with no family pinned selects all members
    Then it sees zero rows

  Scenario: a malformed tenant value fails closed, not with an error
    When app_runtime selects all members with a malformed tenant value
    Then it sees zero rows without an error

  Scenario: the limited role cannot write into another family
    When app_runtime pinned to family "A" inserts a member for family "B"
    Then the write is rejected
