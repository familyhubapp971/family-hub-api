Feature: users table RLS (FHS-349)

  The global users table is locked so each request sees only its own user row.
  The user-mirror upsert runs before tenant context, so it pins the caller's own
  id first and still works under the limited role. The limited role also has the
  grants it needs on the global users + tenants tables.

  Scenario: the limited role sees only its own user row
    Given two users "U" and "V" exist, seeded as the owner
    When app_runtime pinned to user "U" selects all users with no filter
    Then it sees only user "U"

  Scenario: the limited role with no user pinned sees nothing
    Given two users "U" and "V" exist, seeded as the owner
    When app_runtime with no user pinned selects all users
    Then it sees zero rows

  Scenario: the user-mirror upsert works under the limited role
    When the user-mirror upserts a brand-new user as app_runtime
    Then the upsert returns that user row
    And that user row exists in the database

  Scenario: the limited role has the grants it needs on global tables
    Then app_runtime can read and write users
    And app_runtime can read tenants
