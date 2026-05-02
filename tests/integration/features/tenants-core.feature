Feature: tenants-core schema (FHS-3)
  Verifies the 7 family-scoped tables created by migration 0002_tenants_core
  against real Postgres on :5433. Each table carries tenant_id with an
  ON DELETE CASCADE FK to tenants — deleting a family wipes all its
  rows. Covers required-field inserts, FK enforcement, cascade behaviour,
  unique constraints, and the headline tenant-isolation guarantee.

  Background:
    Given the test Postgres has a clean tenants and core tables
    And tenants "alpha" and "beta" exist

  # ─── members ──────────────────────────────────────────────────────────────

  Scenario: Insert a member with required fields applies role default
    When I insert a member into "alpha" with display name "Yusuf"
    Then the member row role is "adult"
    And the member belongs to "alpha"

  Scenario: Member FK rejects a bogus tenant_id
    When I insert a member with a random non-existent tenant_id
    Then the call rejects with a foreign-key violation

  Scenario: Member user_id is nullable so invitees can exist pre-signup
    When I insert a member into "alpha" with display name "Pending Invitee" and no user_id
    Then the member row is persisted with user_id null

  # ─── weeks ────────────────────────────────────────────────────────────────

  Scenario: Two weeks in the same tenant on the same start_date are rejected
    Given a week exists in "alpha" starting on "2026-05-04"
    When I insert another week in "alpha" starting on "2026-05-04"
    Then the call rejects with a unique-constraint error

  Scenario: Same start_date is allowed across different tenants
    Given a week exists in "alpha" starting on "2026-05-04"
    When I insert a week in "beta" starting on "2026-05-04"
    Then the row is persisted

  # ─── habits + week_actions ────────────────────────────────────────────────

  Scenario: Habit cadence enum rejects an unknown value
    When I insert a habit into "alpha" with cadence "occasionally"
    Then the call rejects with an invalid-enum error

  Scenario: week_actions unique on (week_id, member_id, habit_id)
    Given a habit, member, and week exist in "alpha"
    And a week_action records that member completing that habit in that week
    When I insert another week_action with the same week, member, and habit
    Then the call rejects with a unique-constraint error

  # ─── savings_transactions ─────────────────────────────────────────────────

  Scenario: savings_transactions type enum accepts deposit and withdrawal
    Given a savings goal exists in "alpha"
    When I insert a deposit transaction of "100.00" against that goal
    And I insert a withdrawal transaction of "25.00" against that goal
    Then exactly 2 transactions exist for that goal

  Scenario: savings_transactions type enum rejects unknown values
    Given a savings goal exists in "alpha"
    When I insert a transaction with type "transfer" against that goal
    Then the call rejects with an invalid-enum error

  # ─── investments ──────────────────────────────────────────────────────────

  Scenario: investments asset_type enum accepts the documented set
    When I insert investments in "alpha" of every documented asset_type
    Then 6 investments exist in "alpha"

  # ─── tenant isolation (the headline guarantee) ────────────────────────────

  Scenario: Cascade delete — dropping tenant alpha removes all alpha rows; beta survives
    Given tenant "alpha" has a member, week, habit, week_action, savings, transaction, and investment
    And tenant "beta" has a member, week, habit, week_action, savings, transaction, and investment
    When I delete tenant "alpha"
    Then no members, weeks, habits, week_actions, savings, savings_transactions, or investments exist for "alpha"
    And every "beta" row survives untouched
