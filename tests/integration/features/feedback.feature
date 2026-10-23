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

  Scenario: Parent gives feedback on the Meals screen
    When the caller POSTs screen feedback to "feedback-alpha" for screen "meals" with feature "Add meal" and ease 4 in visit "11111111-1111-4111-8111-111111111111"
    Then the feedback POST status is 201
    And the beta_feedback row in "feedback-alpha" has screen "meals", feature "Add meal" and visit "11111111-1111-4111-8111-111111111111"

  Scenario: Answers from one visit share a visit ID
    When the caller POSTs screen feedback to "feedback-alpha" for screen "meals" with feature "Add meal" and ease 4 in visit "22222222-2222-4222-8222-222222222222"
    And the caller POSTs screen feedback to "feedback-alpha" for screen "calendar" with feature "Add activity" and ease 2 in visit "22222222-2222-4222-8222-222222222222"
    Then 2 beta_feedback rows in "feedback-alpha" carry visit "22222222-2222-4222-8222-222222222222"

  Scenario: Screen details alone are not an answer
    When the caller POSTs only screen details to "feedback-alpha"
    Then the feedback POST status is 400
