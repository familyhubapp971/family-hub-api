Feature: Interactive Learn lessons (FHS-283)

  A child answers subject questions; their streak/best/score persist and a
  certificate is awarded at 100%.

  Background:
    Given a family with an adult and a child, and the adult is signed in

  Scenario: questions load with zeroed stats
    When the adult gets Maths questions for the child
    Then the lesson status is 200
    And the questions come without answers
    And the child's score starts at 0

  Scenario: a correct answer raises the score and streak
    When the child answers a Maths question correctly
    Then the answer is graded correct
    And the score is 1 and the streak is 1

  Scenario: a wrong answer resets the streak
    Given the child has answered one Maths question correctly
    When the child answers a Maths question wrongly
    Then the answer is graded wrong
    And the streak is back to 0

  Scenario: reaching the target awards a certificate
    When the child answers Maths correctly 10 times
    Then progress is 100 and a certificate is earned

  Scenario: an outsider cannot answer for this family child
    Given another family with its own signed-in adult
    When the outsider tries to answer for the first child
    Then the lesson request is rejected
    And the first child score is still 0
