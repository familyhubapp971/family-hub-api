Feature: Founder feedback page API (FHS-672)
  Real Postgres on :5433. The founder reads every family's feedback behind a
  passcode; nobody else can.

  Background:
    Given the founder test DB has feedback from two families and the homepage
    And the founder lockout is reset

  Scenario: Founder opens the feedback page
    When the founder signs in with the right passcode
    Then the sign-in returns a page token
    And the feedback list holds answers from both families and the homepage, newest first

  Scenario: Repeated guesses are locked out
    When someone signs in with a wrong passcode 5 times
    And the founder signs in with the right passcode
    Then the founder API answers 429

  Scenario: A burst of parallel guesses cannot skip the lockout
    When someone fires 20 wrong passcodes at once
    Then at most 5 of them are checked

  Scenario: No token, no feedback
    When someone asks for the feedback list without a token
    Then the founder API answers 401

  Scenario: Only the founder reader crosses families
    When the app role with no family pinned reads beta_feedback directly
    Then it sees 0 rows
    When the app role with no family pinned calls the founder reader
    Then it sees all 3 answers
