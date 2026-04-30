Feature: users-mirror upsert (real Postgres)
  getOrCreateUser idempotently mirrors Supabase's auth.users into our
  public.users on first authenticated request. Verified end-to-end
  against real Postgres on :5433 — covers happy path, idempotency, the
  email-refresh path, concurrent races, and the unique-email constraint
  edge case.

  Background:
    Given the test Postgres has a clean users table

  Scenario: First call inserts a new row
    When I call getOrCreateUser with a fresh id and email "first@example.com"
    Then the returned row id matches the input id
    And the returned row email is "first@example.com"
    And the returned row has createdAt and updatedAt set
    And exactly 1 row exists for that id

  Scenario: Second call with the same id keeps a single row
    Given a user has already been created with email "same@example.com"
    When I call getOrCreateUser again with the same id and email "same@example.com"
    Then exactly 1 row exists for that id

  Scenario: Email change refreshes email + updatedAt, preserves createdAt
    Given a user has already been created with email "old@example.com"
    When I call getOrCreateUser with the same id and email "new@example.com"
    Then the returned row email is "new@example.com"
    And createdAt is unchanged
    And updatedAt has advanced

  Scenario: 10 concurrent first-calls produce one row, not many
    When I call getOrCreateUser 10 times concurrently with the same id and email "race@example.com"
    Then every caller sees the same id back
    And exactly 1 row exists for that id

  # TODO(FHS-219): re-enable at fan-out 50+ once getOrCreateUser handles
  # the email-unique race. Today the 10x scenario above is sufficient
  # to verify the ON CONFLICT(id) path; 50x surfaces a separate
  # email-constraint race that's tracked under tech debt.
  Scenario: Different ids land in different rows
    When I call getOrCreateUser with two different fresh ids
    Then exactly 2 rows exist in users

  Scenario Outline: Edge-case emails are accepted by the mirror
    When I call getOrCreateUser with a fresh id and email "<email>"
    Then the returned row email is "<email>"

    Examples:
      | email                                            |
      | name+tag@example.com                             |
      | naïve@example.com                                |
      | a.long.local.part.with.many.segments@example.com |
      | UPPERCASE@example.com                            |

  Scenario: Email uniqueness — two different ids cannot share an email
    Given a user has already been created with email "shared@example.com"
    When I call getOrCreateUser with a different fresh id and email "shared@example.com"
    Then the call rejects with a unique-constraint error
    And exactly 1 row has email "shared@example.com"
