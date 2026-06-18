Feature: GET /api/kid/notices (FHS-355)

  A kid who logs in sees their own family's noticeboard — scoped to the kid
  token's tenant, never another family's.

  Background:
    Given a family "kidfam" with a kid and a notice "Tidy your room"

  Scenario: a kid sees their own family notices
    When the kid GETs /api/kid/notices with their token
    Then the kid notices response status is 200
    And the kid notices include "Tidy your room"

  Scenario: a kid never sees another family notices
    Given another family "otherfam" has a notice "Secret stuff"
    When the kid GETs /api/kid/notices with their token
    Then the kid notices do not include "Secret stuff"
