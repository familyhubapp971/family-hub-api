Feature: ChildWorld habits + rewards sticker economy (FHS-268)
  Real Postgres on :5433 — verifies the kid sticker economy: logging a
  habit earns a sticker, redeeming a reward spends stickers, the balance
  maths is count(habit_logs) - sum(redemptions), and everything is
  tenant-scoped.

  Background:
    Given the test Postgres has clean tenants, members, habits, rewards, and ledger tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Ali"
    And the "khan" tenant has a habit "Brush teeth"
    And the "khan" tenant has a reward "Ice cream" costing 2 stickers

  Scenario: Logging a habit earns a sticker; the balance reflects it
    When the caller logs "Brush teeth" for "Ali" on "2026-06-08"
    Then the log response status is 200
    And "Ali" has a sticker balance of 1 in tenant "khan"

  Scenario: Un-logging a habit removes the sticker
    Given the caller logs "Brush teeth" for "Ali" on "2026-06-08"
    When the caller un-logs "Brush teeth" for "Ali" on "2026-06-08"
    Then the log response status is 200
    And "Ali" has a sticker balance of 0 in tenant "khan"

  Scenario: Redeeming a reward spends stickers
    Given the caller logs "Brush teeth" for "Ali" on "2026-06-08"
    And the caller logs "Brush teeth" for "Ali" on "2026-06-09"
    When the caller redeems "Ice cream" for "Ali" in tenant "khan"
    Then the redeem response status is 201
    And "Ali" has a sticker balance of 0 in tenant "khan"

  Scenario: Redeeming without enough stickers is rejected
    Given the caller logs "Brush teeth" for "Ali" on "2026-06-08"
    When the caller redeems "Ice cream" for "Ali" in tenant "khan"
    Then the redeem response status is 409

  Scenario: Two concurrent redeems with exactly enough stickers can't double-spend
    Given the caller logs "Brush teeth" for "Ali" on "2026-06-08"
    And the caller logs "Brush teeth" for "Ali" on "2026-06-09"
    When the caller fires two redeems of "Ice cream" for "Ali" at once in tenant "khan"
    Then exactly one redeem succeeds and one is rejected
    And "Ali" has a sticker balance of 0 in tenant "khan"

  Scenario: Tenant isolation — another tenant's habit logs never count
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has a child member "Sam"
    And the "smith" tenant has a habit "Read book"
    And the caller logs "Read book" for "Sam" on "2026-06-08" in tenant "smith"
    When the caller GETs habits for "Ali" week "2026-06-08" in tenant "khan"
    Then the habits response status is 200
    And the habits response has 1 habits
    And the habits response has 0 logs
