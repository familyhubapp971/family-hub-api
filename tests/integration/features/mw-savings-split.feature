Feature: My World: savings split into last week and earlier (FHS-606)
  Real Postgres on :5433. The Your Savings card splits the sticker balance
  into what was banked recently ("earned last week") and everything kept from
  before. The two lines must always sum to the sticker total, older balances
  with no recent banking read entirely as kept, and one tenant can never read
  another tenant's split.

  Background:
    Given the test Postgres has clean My World tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Amina"
    And the "khan" tenant has a habit "Read" for "Amina"

  Scenario: freshly banked stickers read as earned last week
    Given the caller places a sticker on "Read" day 0 for "Amina"
    And the caller places a sticker on "Read" day 1 for "Amina"
    When the caller banks 2 stickers into savings for "Amina"
    And the caller fetches savings for "Amina"
    Then the savings show 52 stickers in total
    And the split reads 2 earned last week and 50 kept from earlier

  Scenario: an old balance with no recent banking reads entirely as kept
    When the caller fetches savings for "Amina"
    Then the savings show 50 stickers in total
    And the split reads 0 earned last week and 50 kept from earlier

  Scenario: tenant isolation
    Given a tenant "begum" exists with the caller as an admin member
    When the caller fetches savings for "Amina" through the "begum" tenant
    Then the request is refused as not found
