Feature: An admin can rename the family (FHS-626)
  Real Postgres on :5433. The family's name is editable, the web address it
  lives at is not, and only an admin may change it.

  Background:
    Given the test Postgres has clean admin tables
    And a users mirror row exists for the admin caller
    And a tenant "khan" exists named "Khan Family" with the caller as an admin member

  Scenario: an admin renames the family
    When the admin sets the family name to "The Khans"
    Then the rename is accepted
    And reading the settings back shows the family name "The Khans"

  Scenario: the family's web address does not move
    When the admin sets the family name to "Something Else Entirely"
    Then the rename is accepted
    And the family is still found at the slug "khan"

  Scenario: a blank name is refused
    When the admin sets the family name to "   "
    Then the rename is refused as invalid
    And reading the settings back shows the family name "Khan Family"

  Scenario: a non-admin cannot rename the family
    Given the "khan" tenant has an adult member who is not an admin
    When that adult sets the family name to "Not Allowed"
    Then the rename is refused as forbidden
    And reading the settings back shows the family name "Khan Family"
