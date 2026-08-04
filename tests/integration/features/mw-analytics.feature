Feature: My World: Analytics (FHS-298)
  Real Postgres on :5433, verifies the per-child analytics aggregation:
  a weekly potential-value / completion trend and a habit leaderboard,
  scoped per (tenant, member).

  Background:
    Given the test Postgres has clean My World analytics tables
    And a users mirror row exists for the analytics caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Ali"
    And the "khan" tenant has a habit "Brush teeth" for "Ali"

  Scenario: The weekly trend and leaderboard reflect placed stickers
    Given the caller places a sticker on "Brush teeth" day 0 for "Ali"
    And the caller places a sticker on "Brush teeth" day 1 for "Ali"
    When the caller opens analytics for "Ali"
    Then the analytics response status is 200
    And the analytics trend has 1 week
    And the first analytics week reports 2 potential value
    And the analytics leaderboard has 1 habit
    And the top analytics habit has 2 completed days

  Scenario: An investment doubles that week's potential value
    Given the "khan" tenant has a bonus habit "Help out" for "Ali"
    And the caller places a sticker on "Help out" day 0 for "Ali"
    And the caller also places a sticker on "Help out" day 1 for "Ali"
    And the caller invests 10 stickers in "Help out" for "Ali"
    When the caller opens analytics for "Ali"
    Then the analytics response status is 200
    And the first analytics week reports 20 potential value

  Scenario: Analytics is empty for a child with no habits
    Given the "khan" tenant has a child member "Bilal"
    When the caller opens analytics for "Bilal"
    Then the analytics response status is 200
    And the analytics trend has 0 weeks
    And the analytics leaderboard has 0 habits
