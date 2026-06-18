Feature: RLS tenant isolation sweep (FHS-350)

  Proves the database-level lock holds for EVERY tenant-scoped table when the app
  connects as the limited app_runtime role (not the superuser, which bypasses
  RLS): with a family pinned, an unfiltered SELECT returns only that family's
  rows; with no family pinned, every table returns nothing; writes into another
  family are rejected; rows can't be moved across families; and deletes only
  touch the pinned family.

  Background:
    Given two families "A" and "B" fully seeded as the owner

  Scenario: with a family pinned, every table returns only that family rows
    When app_runtime pinned to family "A" selects every tenant-scoped table unfiltered
    Then every table returns at least one row and only family "A" rows

  Scenario: with no family pinned, every table returns nothing
    When app_runtime with no family pinned selects every tenant-scoped table
    Then every table returns zero rows

  Scenario: a write into another family is rejected
    When app_runtime pinned to family "A" tries to insert a member for family "B"
    Then the insert is rejected

  Scenario: a row cannot be moved to another family by update
    When app_runtime pinned to family "A" tries to reassign its member to family "B"
    Then the update is rejected and family "A" still owns its member

  Scenario: a delete only affects the pinned family
    When app_runtime pinned to family "A" deletes all members unfiltered
    Then only family "A" members are gone and family "B" keeps its member
