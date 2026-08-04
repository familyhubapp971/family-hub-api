Feature: Kid Maths Progression (FHS-394)
  Real Postgres on :5433, verifies the kid-scoped maths progress and
  certificate endpoints. Kid identity comes from the kid token, not a
  memberId parameter. All data is scoped to tenant + member from the token.

  Background:
    Given a family with kid "Maya" in tenant "maths-fam"
    And a second tenant with kid "Omar" in tenant "other-fam"

  Scenario: a kid can upsert their progress and read it back
    When "Maya" PUTs /api/kid/maths/progress with operation "addition" tableNumber 3 learnCompleted true
    Then the maths progress PUT response status is 200
    And the maths progress PUT body has learnCompleted true
    When "Maya" GETs /api/kid/maths/progress
    Then the maths progress GET response status is 200
    And the maths progress list contains a row with operation "addition" tableNumber 3

  Scenario: updating only practiceCorrect does not reset learnCompleted
    When "Maya" PUTs /api/kid/maths/progress with operation "subtraction" tableNumber 1 learnCompleted true
    And "Maya" PUTs /api/kid/maths/progress with operation "subtraction" tableNumber 1 practiceCorrect 5
    When "Maya" GETs /api/kid/maths/progress
    Then the subtraction table 1 row has learnCompleted true and practiceCorrect 5

  Scenario: placement cascade masters qualifying tables and writes certs
    When "Maya" POSTs /api/kid/maths/placement with operation "multiplication" and result tableNumber 3 correct true timeSeconds 3
    Then the placement response status is 200
    And the unlocked list contains 3
    When "Maya" GETs /api/kid/maths/progress
    Then the multiplication table 3 row has placementUnlocked true
    When "Maya" GETs /api/kid/maths/certificates
    Then the certificates list contains an entry for operation "multiplication" difficulty "3"

  Scenario: placement is idempotent: a second call does not duplicate rows
    When "Maya" POSTs /api/kid/maths/placement with operation "division" and result tableNumber 2 correct true timeSeconds 2
    And "Maya" POSTs /api/kid/maths/placement with operation "division" and result tableNumber 2 correct true timeSeconds 2
    When "Maya" GETs /api/kid/maths/certificates
    Then the division certificates count for table "2" is 1

  Scenario: a kid earns a certificate and it is returned with alreadyEarned false
    When "Maya" POSTs /api/kid/maths/certificates with operation "addition" difficulty "easy" totalCorrect 12
    Then the cert POST response status is 201
    And the cert response has alreadyEarned false

  Scenario: posting the same certificate twice returns alreadyEarned true
    When "Maya" POSTs /api/kid/maths/certificates with operation "addition" difficulty "hard" totalCorrect 10
    And "Maya" POSTs /api/kid/maths/certificates with operation "addition" difficulty "hard" totalCorrect 10
    Then the cert response has alreadyEarned true

  Scenario: tenant isolation: a kid in another tenant sees zero of Maya's progress
    When "Maya" PUTs /api/kid/maths/progress with operation "addition" tableNumber 5 learnCompleted true
    When "Omar" GETs /api/kid/maths/progress
    Then the maths progress GET response status is 200
    And the maths progress list is empty

  Scenario: tenant isolation: a kid in another tenant sees zero of Maya's certificates
    When "Maya" POSTs /api/kid/maths/certificates with operation "multiplication" difficulty "6" totalCorrect 10
    When "Omar" GETs /api/kid/maths/certificates
    Then the certificates list is empty

  Scenario: same-tenant member isolation: a sibling sees none of Maya's progress
    Given a sibling "Lily" in the same tenant as Maya
    When "Maya" PUTs /api/kid/maths/progress with operation "addition" tableNumber 7 learnCompleted true
    And "Maya" POSTs /api/kid/maths/certificates with operation "addition" difficulty "7" totalCorrect 10
    When "Lily" GETs /api/kid/maths/progress
    Then the maths progress list is empty
    When "Lily" GETs /api/kid/maths/certificates
    Then the certificates list is empty

  Scenario: all-wrong placement returns empty unlocked and writes no rows
    When "Maya" POSTs /api/kid/maths/placement with all-wrong results for operation "addition" tableNumber 5
    Then the placement response status is 200
    And the unlocked list is empty
    When "Maya" GETs /api/kid/maths/progress
    Then the maths progress list is empty
