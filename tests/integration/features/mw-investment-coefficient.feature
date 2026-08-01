Feature: My World — per-investment coefficient (FHS-534)
  Real Postgres on :5433 — verifies that a parent-chosen coefficient (preset
  1/2/3/5) on an investment is persisted on the mw_investments row AND pushed
  onto the invested habit's `boost` (the invest→pay link), that omitting the
  coefficient falls back to the legacy default of 5, that daily growth uses
  the coefficient (not a hardcoded +5/day), and that a caller cannot invest
  in another tenant's habit. Scoped per (tenant, member).

  Background:
    Given the test Postgres has clean My World tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Ali"
    And the "khan" tenant has a habit "Read" for "Ali"

  Scenario: Investing with a chosen coefficient sets it on the investment and the habit's boost
    When the caller invests 10 stickers in "Read" for "Ali" with coefficient 3
    Then the investment response status is 201
    And the investment response coefficient is 3
    And "Read" habit boost is 3

  Scenario: Investing without a coefficient defaults to 5 on the investment and the habit's boost
    When the caller invests 10 stickers in "Read" for "Ali"
    Then the investment response status is 201
    And the investment response coefficient is 5
    And "Read" habit boost is 5

  Scenario: Daily growth uses the investment's coefficient, not a hardcoded rate
    Given the caller completes all 7 days of "Read" for "Ali"
    And the caller invests 10 stickers in "Read" for "Ali" with coefficient 2
    When the caller opens investments for "Ali"
    Then "Ali" first investment is worth 24 stickers

  Scenario: A caller cannot invest in another tenant's habit
    Given a tenant "acme" exists with the caller as an admin member
    And the "acme" tenant has a child member "Zara"
    When the caller invests 10 stickers in "Read" for "Zara" in tenant "acme"
    Then the investment response status is 404

  Scenario: Withdrawing an active investment uses its own coefficient, not a hardcoded rate
    Given the caller completes all 7 days of "Read" for "Ali"
    And the caller invests 10 stickers in "Read" for "Ali" with coefficient 2
    When the caller withdraws 10 stickers from the investment for "Ali"
    Then the withdraw response withdrawn stickers is 10
    And the withdraw response remaining stickers is 14

  Scenario: Closing the week matures an active investment at its own coefficient, not a hardcoded rate
    Given the caller completes all 7 days of "Read" for "Ali"
    And the caller invests 10 stickers in "Read" for "Ali" with coefficient 3
    When the caller closes the current week for "Ali"
    Then the finalize response investment returns is 15.5

  Scenario: Editing the habit's pay later does not disturb an active investment's growth
    Given the caller invests 10 stickers in "Read" for "Ali" with coefficient 5
    And the caller completes all 7 days of "Read" for "Ali"
    When the caller sets "Read" habit boost to 2 for "Ali"
    And the caller opens investments for "Ali"
    Then "Ali" first investment is worth 45 stickers
    And "Read" habit boost is 2
