Feature: ChildWorld habits + sticker economy (FHS-292)
  Real Postgres on :5433 — verifies the kid sticker economy: placing a
  typed sticker on a habit day earns its value, redeeming a reward spends
  the balance (earned sticker values - redemptions), and everything is
  tenant-scoped.

  Background:
    Given the test Postgres has clean tenants, members, habits, rewards, and ledger tables
    And a users mirror row exists for the test caller
    And a tenant "khan" exists with the caller as an admin member
    And the "khan" tenant has a child member "Ali"
    And the "khan" tenant has a habit "Brush teeth"
    And the "khan" tenant has a reward "Ice cream" costing 2 stickers

  Scenario: Placing a sticker earns it; the balance reflects it
    When the caller places a sticker on "Brush teeth" day 0 for "Ali"
    Then the sticker response status is 200
    And "Ali" has a sticker balance of 1 in tenant "khan"

  Scenario: Removing a sticker drops the balance
    Given the caller places a sticker on "Brush teeth" day 0 for "Ali"
    When the caller removes the sticker on "Brush teeth" day 0 for "Ali"
    Then the sticker response status is 204
    And "Ali" has a sticker balance of 0 in tenant "khan"

  Scenario: Redeeming a reward spends stickers
    Given the caller places a sticker on "Brush teeth" day 0 for "Ali"
    And the caller also places a sticker on "Brush teeth" day 1 for "Ali"
    When the caller redeems "Ice cream" for "Ali" in tenant "khan"
    Then the redeem response status is 201
    And "Ali" has a sticker balance of 0 in tenant "khan"

  Scenario: Redeeming without enough stickers is rejected
    Given the caller places a sticker on "Brush teeth" day 0 for "Ali"
    When the caller redeems "Ice cream" for "Ali" in tenant "khan"
    Then the redeem response status is 409

  Scenario: Two concurrent redeems with exactly enough stickers can't double-spend
    Given the caller places a sticker on "Brush teeth" day 0 for "Ali"
    And the caller also places a sticker on "Brush teeth" day 1 for "Ali"
    When the caller fires two redeems of "Ice cream" for "Ali" at once in tenant "khan"
    Then exactly one redeem succeeds and one is rejected
    And "Ali" has a sticker balance of 0 in tenant "khan"

  Scenario: Each child earns on their own habit; cross-child placement is rejected
    Given the "khan" tenant has a child member "Bilal"
    And the "khan" tenant has a habit "Tidy room"
    And the caller places a sticker on "Brush teeth" day 0 for "Ali"
    And the caller also places a sticker on "Tidy room" day 0 for "Bilal"
    Then "Ali" has a sticker balance of 1 in tenant "khan"
    And "Bilal" has a sticker balance of 1 in tenant "khan"
    And placing a sticker on "Brush teeth" day 1 for "Bilal" is rejected with 404

  Scenario: Bonus habit earns 5 stickers per day
    Given the "khan" tenant has a bonus habit "Help out"
    When the caller places a sticker on "Help out" day 0 for "Ali"
    Then the sticker response status is 200
    And "Ali" has a sticker balance of 5 in tenant "khan"

  Scenario: Tenant isolation — another tenant's stickers never count
    Given a second tenant "smith" exists with the caller as an admin member
    And the "smith" tenant has a child member "Sam"
    And the "smith" tenant has a habit "Read book"
    And the caller places a sticker on "Read book" day 0 for "Sam" in tenant "smith"
    When the caller GETs habits for "Ali" in tenant "khan"
    Then the habits response status is 200
    And the habits response has 1 habits
    And the habits response has 0 stickers

  Scenario: Each child sees only their own habits (multi-child)
    Given the "khan" tenant has a child member "Bilal"
    And the "khan" tenant has a habit "Read book"
    When the caller GETs habits for "Ali" in tenant "khan"
    Then the habits response status is 200
    And the habits response has 1 habits
