Feature: POST /api/feedback (FHS-418)
  Real Postgres on :5433, verifies beta feedback storage and tenant isolation.

  Background:
    Given the feedback test DB is clean
    And a users mirror row exists for the feedback test caller
    And a feedback tenant "feedback-alpha" exists with the caller as an admin member

  Scenario: POST with valid answers returns 201 and persists the row
    When the caller POSTs feedback to "feedback-alpha" with pmfDisappointment "very" and painPoint "Onboarding is confusing"
    Then the feedback POST status is 201
    And the feedback response contains a valid id
    And a beta_feedback row exists in "feedback-alpha" with pmf_disappointment "very"

  Scenario: POST with empty body returns 400
    When the caller POSTs an empty feedback body to "feedback-alpha"
    Then the feedback POST status is 400

  Scenario: Tenant isolation: tenant B cannot read tenant A feedback
    Given a second feedback tenant "feedback-beta" exists with the caller as an admin member
    When the caller POSTs feedback to "feedback-alpha" with pmfDisappointment "somewhat" and painPoint "Too slow"
    Then no beta_feedback row exists in "feedback-beta"
