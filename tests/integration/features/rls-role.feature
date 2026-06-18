Feature: RLS database role (FHS-347)

  So Postgres can enforce Row-Level Security, the app connects as a limited
  "app_runtime" login that cannot bypass RLS, cannot own tables, and cannot
  run DDL. Migrations keep running as the owner role.

  Scenario: app_runtime is a policed, non-privileged login
    Given the app_runtime role exists
    Then it has neither BYPASSRLS nor SUPERUSER
    And it owns none of the tenant-scoped tables

  Scenario: app_runtime has exactly CRUD and nothing more
    Given the app_runtime role exists
    Then it has SELECT, INSERT, UPDATE and DELETE on every tenant-scoped table
    And it has no TRUNCATE, REFERENCES or TRIGGER privilege on those tables
    And it cannot create objects in the public schema
