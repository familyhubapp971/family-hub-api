Feature: Kid read-only habits

  A logged-in kid reads their OWN weekly habits (FHS-374). Sticker writes
  were removed in FHS-374: a kid is now view-only on My World. Real kid
  token against real Postgres.

  Background:
    Given a family with kid "Iman" (habit "Read a book") and sibling "Yusuf" (habit "Tidy room")

  Scenario: a kid reads only their own habits for the current week
    When the kid GETs /api/kid/habits with their token
    Then the kid habits response status is 200
    And the kid habits include "Read a book"
    And the kid habits do not include "Tidy room"

  Scenario: a kid can request habits for a specific past week by weekId
    When the kid GETs /api/kid/habits with a valid weekId
    Then the kid habits response status is 200

  Scenario: a kid gets 404 for a weekId that belongs to a sibling
    When the kid requests habits for a sibling's weekId
    Then the kid habits response status is 404
