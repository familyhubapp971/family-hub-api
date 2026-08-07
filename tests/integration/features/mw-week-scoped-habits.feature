Feature: My World: a closed week's habit list is scoped to that week (FHS-616)

  A finalized (closed) week is meant to be an unchangeable record. Before this
  fix, the server loaded a week's habit list by "not archived right now", with
  no date scoping, so any habit created after a week closed grew a phantom
  card on every past week and any habit archived after a week closed vanished
  from weeks it actually belonged to. Real Postgres on :5433.

  Background:
    Given the test Postgres has clean My World tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Ali"
    And the "khan" tenant has a habit "Reading" for "Ali"

  Scenario: A habit created after a week closes does not appear in that week
    Given the caller closes the current week for "Ali"
    And the caller creates a habit "Piano" for "Ali"
    When the caller views habits for "Ali" in the closed week
    Then the habit list includes "Reading"
    And the habit list does not include "Piano"

  Scenario: A habit archived after a week closes still appears in that week
    Given the caller closes the current week for "Ali"
    And the caller archives the habit "Reading" for "Ali"
    When the caller views habits for "Ali" in the closed week
    Then the habit list includes "Reading"

  Scenario: The live week reflects a new habit and an archived habit immediately
    Given the caller creates a habit "Piano" for "Ali"
    And the caller archives the habit "Reading" for "Ali"
    When the caller views habits for "Ali" in the current week
    Then the habit list includes "Piano"
    And the habit list does not include "Reading"

  # Real-world safety net: a habit's `created_at` can postdate a week it
  # actually belonged to (seeded/backfilled data, a re-created row, a close
  # whose captured moment predates some habit's insert). A sticker recorded
  # for that exact (habit, week) is proof the habit existed then, whatever
  # its `created_at` says, so it must still count.
  Scenario: A habit whose sticker is recorded for a closed week still appears, even with a late createdAt
    Given the caller closes the current week for "Ali"
    And the caller creates a habit "Piano" for "Ali"
    And the caller places a sticker on "Piano" day 0 for "Ali" in the closed week
    When the caller views habits for "Ali" in the closed week
    Then the habit list includes "Piano"
