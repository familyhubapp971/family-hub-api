Feature: POST /api/public/feedback (FHS-429)
  Real Postgres on :5433, verifies anonymous public feedback storage with no auth required.

  Background:
    Given the public_feedback table is clean

  Scenario: POST with survey answers returns 201 and persists the row
    When an anonymous visitor POSTs public feedback with pmfDisappointment "very" and painPoint "Hard to set up"
    Then the public feedback POST status is 201
    And the public feedback response contains a valid id
    And a public_feedback row exists with pmf_disappointment "very"

  Scenario: POST with only name and email returns 400
    When an anonymous visitor POSTs public feedback with only name "Alice" and email "alice@example.com"
    Then the public feedback POST status is 400

  Scenario: POST with junk types returns 400
    When an anonymous visitor POSTs public feedback with invalid body
    Then the public feedback POST status is 400

  Scenario: POST with a survey answer but a malformed email returns 400
    When an anonymous visitor POSTs public feedback with pmfDisappointment "very" and a malformed email "not-an-email"
    Then the public feedback POST status is 400
