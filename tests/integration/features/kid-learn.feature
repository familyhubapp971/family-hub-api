Feature: Kid learn + reading log

  A logged-in kid does lessons (Maths/Science/Logic) and keeps a reading log,
  scoped to themselves — never a sibling's (FHS-367). Real kid token against
  real Postgres.

  Background:
    Given a family with kid "Iman" and sibling "Yusuf"

  Scenario: a kid sees their lesson subjects
    When the kid "Iman" GETs /api/kid/learn
    Then the kid learn response status is 200
    And the kid learn subjects include "Maths"
    And the kid learn subjects include "Logic"

  Scenario: a kid answers a lesson question
    When the kid "Iman" answers a Maths question
    Then the answer response status is 200
    And the kid Maths answered count is 1

  Scenario: a kid keeps a reading log, scoped to themselves
    When the kid "Iman" adds the book "Matilda"
    Then the add-book response status is 201
    And reading "Iman" books includes "Matilda"
    And reading "Yusuf" books is empty

  Scenario: a kid cannot change a sibling's book
    When "Yusuf" tries to mark "Iman"'s book finished
    Then the sibling change response status is 404

  Scenario: a kid explores Logic sub-topics
    When the kid "Iman" fetches Logic questions filtered by subtopic "patterns"
    Then the subtopic questions response status is 200
    And all returned questions have subtopic "patterns"
