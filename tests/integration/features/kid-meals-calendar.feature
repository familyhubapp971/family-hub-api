Feature: Kid meals + calendar

  A logged-in kid sees the family meal plan and schedule scoped to themselves +
  family-wide entries: never a sibling's private meals or events (FHS-365).
  Real kid token against real Postgres.

  Background:
    Given a family with kid "Iman", sibling "Yusuf", family + per-kid meals, and family + per-kid events this week

  Scenario: a kid sees their own + family meals, not a sibling's
    When the kid GETs /api/kid/meals
    Then the kid meals response status is 200
    And the kid meals include "Pasta"
    And the kid meals include "Iman Snack"
    And the kid meals do not include "Yusuf Lunch"

  Scenario: a kid sees their own + family events, not a sibling's
    When the kid GETs /api/kid/events
    Then the kid events response status is 200
    And the kid events include "Family Movie"
    And the kid events include "Iman Football"
    And the kid events do not include "Yusuf Dentist"

  Scenario: an invalid weekStart is rejected
    When the kid GETs /api/kid/events with weekStart "not-a-date"
    Then the kid events response status is 400
