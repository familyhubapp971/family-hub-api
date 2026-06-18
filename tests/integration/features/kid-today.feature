Feature: GET /api/kid/today (FHS-355)

  A logged-in kid sees their OWN active habits — not another member's, and not
  archived ones.

  Background:
    Given a family with kid habit "Read a book", a grown-up habit "Exercise", and an archived kid habit "Old habit"

  Scenario: a kid sees only their own active habits
    When the kid GETs /api/kid/today with their token
    Then the kid today response status is 200
    And the kid habits include "Read a book"
    And the kid habits do not include "Exercise"
    And the kid habits do not include "Old habit"
