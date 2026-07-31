Feature: Configurable reward economy (FHS-512)

  Real Postgres on :5433. The family's "1 sticker is worth" rate is
  configurable (a family default, overridable per child), a habit's boost
  sets how many stickers a completion is worth, and a skip penalty deducts
  money from savings automatically at close-week. Every money figure is
  checked in INTEGER MINOR UNITS (e.g. 50 = 0.50).

  Background:
    Given the test Postgres has clean reward-config tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Ali"

  Scenario: GET reward-config returns the default family rate for a family that never configured one
    When the caller GETs the reward config
    Then the reward-config response status is 200
    And the family rate is 50 minor units

  Scenario: PUT reward-config as a non-admin is forbidden
    Given the "khan" tenant has a non-admin member "Sam"
    When "Sam" PUTs the reward config with familyRateMinor 75
    Then the reward-config response status is 403

  Scenario: An admin sets the family default rate and it is reflected in a child's savings
    Given "Ali" has 4 saved stickers and no saved cash
    When the caller PUTs the reward config with familyRateMinor 75
    Then the reward-config response status is 200
    And "Ali" savings stickerRate is 0.75

  Scenario: An admin sets a per-child override that takes precedence over the family default
    When the caller PUTs a rate override of 100 minor units for "Ali"
    Then "Ali" effective rate is 100 minor units
    And the family default rate is still 50 minor units

  Scenario: Clearing a child's rate override falls back to the family default
    Given "Ali" has a rate override of 100 minor units
    When the caller clears "Ali" rate override
    Then "Ali" effective rate is 50 minor units

  Scenario: A boosted habit awards more stickers per completion
    Given the "khan" tenant has a habit "Big chore" for "Ali" with boost 3
    When the caller places a sticker on "Big chore" day 0 for "Ali"
    Then the placed sticker is worth 3

  Scenario: A skip penalty deducts money from savings at close-week
    Given the "khan" tenant has a habit "Brush teeth" for "Ali" with a skip penalty of 25 minor units
    And "Ali" has 10.00 saved cash and no saved stickers
    When the caller closes the current week for "Ali"
    Then the finalize response reports a skip penalty of 175 minor units
    And "Ali" saved cash is 1.75 lower than before close

  Scenario: A skip penalty never lets saved cash go below zero
    Given the "khan" tenant has a habit "Brush teeth" for "Ali" with a skip penalty of 500 minor units
    And "Ali" has 1.00 saved cash and no saved stickers
    When the caller closes the current week for "Ali"
    Then "Ali" saved cash is 0

  Scenario: Only DUE days that are actually missing a sticker are penalised
    Given the "khan" tenant has a habit "Brush teeth" for "Ali" with a skip penalty of 25 minor units
    And the caller places stickers on "Brush teeth" days 0 and 1 for "Ali"
    When the caller closes the current week for "Ali"
    Then the finalize response reports a skip penalty of 125 minor units

  Scenario: Reopening a week restores the skip-penalty deduction
    Given the "khan" tenant has a habit "Brush teeth" for "Ali" with a skip penalty of 25 minor units
    And "Ali" has 10.00 saved cash and no saved stickers
    When the caller closes the current week for "Ali"
    And the caller reopens that week for "Ali"
    Then "Ali" saved cash is back to what it was before close

  Scenario: Reopening a floored week restores only what was actually debited, never fabricating money
    Given the "khan" tenant has a habit "Brush teeth" for "Ali" with a skip penalty of 500 minor units
    And "Ali" has 1.00 saved cash and no saved stickers
    When the caller closes the current week for "Ali"
    Then "Ali" saved cash is 0
    When the caller reopens that floored week for "Ali"
    Then "Ali" saved cash is restored to 1, not the full nominal penalty

  Scenario: reward-config is tenant-isolated
    Given a second tenant "smith" exists with its own admin caller
    When the "smith" caller PUTs their family rate to 200 minor units
    Then "khan" family rate is still 50 minor units
