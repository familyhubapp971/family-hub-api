Feature: GET /api/public/kid-members/:slug (FHS-238)
  Real Postgres on :5433 — verifies the avatar grid endpoint that
  feeds /t/:slug/kid-login. No auth required (the slug is the access
  boundary). Returns the family display name + every kid member that
  has a PIN set, sorted by display name.

  Background:
    Given the test Postgres has clean tenants and members tables

  Scenario: Returns family + only kids with PINs, sorted alphabetically
    Given the tenant "khan" named "Khan Family" has these members:
      | name  | role  | pin  |
      | Yusuf | child | 1111 |
      | Aisha | child | 2222 |
      | Sarah | adult |      |
      | Iman  | child |      |
    When I GET /api/public/kid-members/khan
    Then the response status is 200
    And the family name is "Khan Family"
    And the kids list has exactly 2 entries
    And the kids list in order is "Aisha,Yusuf"

  Scenario: Unknown slug returns 404
    When I GET /api/public/kid-members/no-such-family
    Then the response status is 404

  Scenario: Uppercase slug is normalised so iOS-autocapitalised links resolve
    Given the tenant "khan" named "Khan Family" has these members:
      | name | role  | pin  |
      | Iman | child | 1234 |
    When I GET /api/public/kid-members/Khan
    Then the response status is 200
    And the family name is "Khan Family"

  Scenario: Tenant isolation — kids in another tenant are never returned
    Given the tenant "khan" named "Khan Family" has these members:
      | name | role  | pin  |
      | Iman | child | 1234 |
    And the tenant "patel" named "Patel Family" has these members:
      | name | role  | pin  |
      | Riya | child | 9999 |
    When I GET /api/public/kid-members/khan
    Then the response status is 200
    And the kids list has exactly 1 entries
    And the kids list in order is "Iman"
