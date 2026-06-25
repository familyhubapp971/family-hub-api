Feature: Kid Logic Progression (FHS-395)
  Real Postgres on :5433 — verifies the kid-scoped logic question,
  answer-grading, and certificate endpoints. Kid identity comes from the
  kid token, not a memberId parameter. All data is scoped to tenant + member.

  Background:
    Given a family with logic kid "Alex" in tenant "logic-fam"
    And a second logic tenant with kid "Sam" in tenant "logic-other-fam"

  Scenario: GET /api/kid/logic/questions returns questions with answers stripped
    When "Alex" GETs /api/kid/logic/questions with gameType "truefalse" difficulty "easy"
    Then the logic questions response status is 200
    And the logic questions response has a non-empty questions array
    And no question in the response has an "answer" field

  Scenario: 400 on invalid gameType
    When "Alex" GETs /api/kid/logic/questions with gameType "invalid" difficulty "easy"
    Then the logic questions response status is 400

  Scenario: 400 on invalid difficulty
    When "Alex" GETs /api/kid/logic/questions with gameType "truefalse" difficulty "extreme"
    Then the logic questions response status is 400

  Scenario: correct answer increments combo progress
    Given "Alex" fetches a truefalse easy question
    When "Alex" POSTs the correct answer to /api/kid/logic/answer
    Then the logic answer response status is 200
    And the logic answer body has correct true
    And the logic answer body has comboCorrect 1
    And the logic answer body has certificateEarned false

  Scenario: wrong answer does not increment combo progress
    Given "Alex" fetches a truefalse easy question
    When "Alex" POSTs the WRONG answer to /api/kid/logic/answer
    Then the logic answer response status is 200
    And the logic answer body has correct false
    And the logic answer body has comboCorrect 0

  Scenario: certificate awarded at 10 correct answers for the same combo
    Given "Alex" answers 9 truefalse easy questions correctly
    When "Alex" POSTs the correct answer to the 10th truefalse easy question
    Then the logic answer response status is 200
    And the logic answer body has certificateEarned true
    When "Alex" GETs /api/kid/logic/certificates
    Then the logic certificates list contains a cert for gameType "truefalse" difficulty "easy"

  Scenario: certificate award is idempotent for the same combo
    Given "Alex" answers 10 truefalse easy questions correctly
    When "Alex" answers 1 more truefalse easy question correctly
    Then the logic certificates list has exactly 1 cert for gameType "truefalse" difficulty "easy"

  Scenario: GET /api/kid/logic/certificates returns empty array initially
    When "Alex" GETs /api/kid/logic/certificates
    Then the logic certificates response status is 200
    And the logic certificates list is empty

  Scenario: 400 when questionId is unknown
    When "Alex" POSTs /api/kid/logic/answer with unknown questionId
    Then the logic answer response status is 400

  Scenario: tenant isolation — Sam sees none of Alex's progress or certs
    Given "Alex" answers 10 truefalse easy questions correctly
    When "Sam" GETs /api/kid/logic/certificates
    Then the logic certificates response status is 200
    And the logic certificates list is empty

  Scenario: same-tenant member isolation — a sibling sees none of Alex's certs
    Given a logic sibling "Jordan" in the same tenant as Alex
    And "Alex" answers 10 truefalse easy questions correctly
    When "Jordan" GETs /api/kid/logic/certificates
    Then the logic certificates list is empty

  Scenario: wrong x9 then correct x1 gives comboCorrect 1 not 10
    Given "Alex" submits 9 wrong truefalse easy answers
    When "Alex" then submits 1 correct truefalse easy answer
    Then comboCorrect is 1 and certificateEarned is false
