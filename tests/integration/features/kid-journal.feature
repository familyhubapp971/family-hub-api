Feature: Kid journal (read-only)

  A logged-in kid READS their own journal — a given day and their past entries —
  never a sibling's. Kids no longer write; a parent authors entries (FHS-376).
  Real kid token against real Postgres.

  Background:
    Given a family with kid "Iman" and sibling "Yusuf"

  Scenario: a kid reads back a journal entry for today
    Given "Iman" has a journal entry for today with body "Great day"
    When the kid "Iman" reads their journal for today
    Then reading "Iman" journal for today shows body "Great day"

  Scenario: a sibling does not see another kid's journal
    Given "Iman" has a journal entry for today with body "Great day"
    When the kid "Yusuf" reads their journal for today
    Then reading "Yusuf" journal for today shows no entry

  Scenario: an invalid journal date is rejected
    When the kid "Iman" reads their journal for date "not-a-date"
    Then the journal read status is 400
