Feature: tenant-isolation audit (FHS-6)
  Cross-tenant leak audit across every tenant-scoped table.
  All queries run against real Postgres on :5433. The registry in
  schema.ts drives the parametrised assertions — adding a new table
  without registering it causes the schema-audit scenario to fail.

  Background:
    Given the test Postgres is clean for the tenant-isolation audit

  Scenario: Schema audit — registry matches tables with tenant_id
    Then every table in TENANT_SCOPED_TABLES has a tenant_id column
    And no unregistered table in the schema carries tenant_id

  Scenario: Cross-tenant query isolation — tenant A rows never appear for tenant B
    Given tenant "A" and tenant "B" exist with one fixture row each in every scoped table
    Then querying each scoped table with tenant A's id returns only A's rows
    And querying each scoped table with tenant B's id returns only B's rows

  Scenario: Total-row sanity — fixture inserts both rows per table
    Given tenant "A" and tenant "B" exist with one fixture row each in every scoped table
    Then each scoped table has exactly 2 rows in total
