Feature: My World — Close Week / finalize (FHS-297)
  Real Postgres on :5433 — verifies finalizing a week: unallocated stickers
  auto-save into savings, the next ISO week is created, investments resolve
  or continue, and everything is scoped per (tenant, member).

  Background:
    Given the test Postgres has clean My World tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Ali"
    And the "khan" tenant has a bonus habit "Help out" for "Ali"

  Scenario: Closing a week auto-saves unallocated stickers and opens the next week
    Given the caller places a sticker on "Help out" day 0 for "Ali"
    When the caller closes the current week for "Ali"
    Then the finalize response status is 200
    And the finalize response reports 5 stickers auto-saved
    And the finalize response opens a next week
    And "Ali" has 5 saved stickers in tenant "khan"

  Scenario: An investment resolves to savings on close when not continued
    Given the caller places a sticker on "Help out" day 0 for "Ali"
    And the caller places a sticker on "Help out" day 1 for "Ali"
    And the caller invests 10 stickers in "Help out" for "Ali"
    When the caller closes the current week for "Ali"
    Then the finalize response status is 200
    And the finalize response reports investment returns above 0
    And "Ali" has 0 active investments in tenant "khan"

  Scenario: A continued investment carries into the next week
    Given the caller places a sticker on "Help out" day 0 for "Ali"
    And the caller places a sticker on "Help out" day 1 for "Ali"
    And the caller invests 10 stickers in "Help out" for "Ali"
    When the caller closes the current week continuing the investment for "Ali"
    Then the finalize response status is 200
    And the finalize response reports 1 continued investment
    And "Ali" has 1 active investments in tenant "khan"

  Scenario: A week cannot be finalized twice
    When the caller closes the current week for "Ali"
    And the caller closes the current week for "Ali"
    Then the finalize response status is 409

  Scenario: An investment's value reflects every completed day, not just elapsed ones
    Given the caller completes all 7 days of "Help out" for "Ali"
    And the caller invests 10 stickers in "Help out" for "Ali"
    When the caller opens investments for "Ali"
    Then "Ali" first investment is worth 45 stickers

  Scenario: No new week opens while an earlier week is still open
    Given "Ali" has an earlier open week from 2020
    When the caller checks the current week for "Ali"
    Then the current week is the 2020 week

  Scenario: A caller cannot finalize across members
    Given the "khan" tenant has a child member "Bilal"
    When the caller closes "Ali" current week using "Bilal" as the member
    Then the finalize response status is 404
