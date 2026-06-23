Feature: Kid stats / analytics

  A logged-in kid sees their OWN My World stats — habit success + weekly trend —
  never a sibling's (FHS-369). Real kid token against real Postgres.

  Background:
    Given a kid "Iman" with habit "Read a book" and a sticker this week, plus sibling "Yusuf"

  Scenario: a kid sees their habit analytics
    When the kid "Iman" GETs /api/kid/analytics
    Then the kid analytics response status is 200
    And the kid habit stats include "Read a book"
    And the kid stars earned is at least 1

  Scenario: a kid's analytics never include a sibling's habits
    When the kid "Yusuf" GETs /api/kid/analytics
    Then the kid analytics response status is 200
    And the kid habit stats do not include "Read a book"
