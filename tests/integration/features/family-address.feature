Feature: Old family addresses (FHS-715)
  Real Postgres on :5433. A family that moved from a surname address to a
  private code can be found by its old address only by its own members.
  Nobody learns a family or its kids from a surname.

  Background:
    Given the test Postgres has a family with code "e29b-41d4" that used to be "smith"
    And a users mirror row exists for the test user

  Scenario: A family's own member is sent to the new address
    Given the test user is a member of that family
    When the test user asks where "smith" moved
    Then the answer status is 200
    And the new address is "e29b-41d4"

  Scenario: Someone outside the family learns nothing
    When the test user asks where "smith" moved
    Then the answer status is 404

  Scenario: The kids' faces never show for an old surname
    When anyone asks for the kids of "smith"
    Then the answer status is 404
