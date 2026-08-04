Feature: My World: deductible vs non-deductible investments (FHS-378)
  Real Postgres on :5433, verifies that a non-deductible investment still
  counts missed days but loses no value for them, while a deductible one drops
  by the −2/day penalty, that GET returns the flag, and that the flag survives
  a close-week continuation. Scoped per (tenant, member).

  The matured value is asserted on the continued investment's new principal
  (invested_stickers after roll-over), which is deterministic: unlike a fresh
  GET that re-derives value against the new (real-clock) week.

  Background:
    Given the test Postgres has clean My World tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Ali"
    And the "khan" tenant has a habit "Read" for "Ali"

  Scenario: GET returns the deductible flag for a non-deductible investment
    Given the caller places a sticker on "Read" day 0 for "Ali"
    And the caller places a sticker on "Read" day 1 for "Ali"
    And the caller invests 10 non-deductible stickers in "Read" for "Ali"
    When the caller opens investments for "Ali"
    Then "Ali" first investment deductible flag is false

  Scenario: A non-deductible investment loses no value to missed days on close
    Given the caller places a sticker on "Read" day 0 for "Ali"
    And the caller places a sticker on "Read" day 1 for "Ali"
    And the caller invests 10 non-deductible stickers in "Read" for "Ali"
    When the caller closes the current week continuing the investment for "Ali"
    Then "Ali" continued investment principal is 20 stickers

  Scenario: A deductible investment drops by the penalty for missed days on close
    Given the caller places a sticker on "Read" day 0 for "Ali"
    And the caller places a sticker on "Read" day 1 for "Ali"
    And the caller invests 10 deductible stickers in "Read" for "Ali"
    When the caller closes the current week continuing the investment for "Ali"
    Then "Ali" continued investment principal is 10 stickers

  Scenario: The deductible flag is preserved across a close-week continuation
    Given the caller places a sticker on "Read" day 0 for "Ali"
    And the caller places a sticker on "Read" day 1 for "Ali"
    And the caller invests 10 non-deductible stickers in "Read" for "Ali"
    When the caller closes the current week continuing the investment for "Ali"
    Then "Ali" continued investment is still non-deductible

  Scenario: The settings endpoint toggles the flag and recalculates value
    Given the caller places a sticker on "Read" day 0 for "Ali"
    And the caller places a sticker on "Read" day 1 for "Ali"
    And the caller invests 10 deductible stickers in "Read" for "Ali"
    When the caller sets the investment for "Ali" to non-deductible
    Then the settings response status is 200
    And the settings response deductible flag is false
