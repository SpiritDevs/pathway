import XCTest

final class PathwayIssuesUITests: XCTestCase {
    @MainActor
    func testCompactRowsAndIssueEditing() throws {
        let app = launchFixture()
        let first = app.buttons["issue-row-PW-248"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "issue-row-"))
        XCTAssertGreaterThanOrEqual(rows.allElementsBoundByIndex.filter(\.isHittable).count, 11)
        XCTAssertFalse(app.textFields["Search issues"].exists)
        capture(app, name: "Compact issue list")
        first.tap()
        XCTAssertTrue(app.buttons["issue-detail-actions"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["PW-248"].exists)
        XCTAssertFalse(app.buttons["issue-detail-done"].exists)
        XCTAssertFalse(app.buttons["agent-orchestrator-button"].isHittable)
        capture(app, name: "Issue detail navigation screen")
        app.buttons["issue-detail-actions"].tap()
        app.buttons["Edit issue"].tap()
        let input = app.descendants(matching: .any).matching(identifier: "issue-title-input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        capture(app, name: "Edit issue sheet from detail")
        input.tap()
        input.typeText(" after reconnect")
        app.buttons["issue-save"].tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "after reconnect")).firstMatch.waitForExistence(timeout: 5))
    }

    @MainActor
    func testCreateIssue() throws {
        let app = launchFixture()
        XCTAssertTrue(app.buttons["New issue"].waitForExistence(timeout: 10))
        app.buttons["New issue"].tap()
        let title = app.descendants(matching: .any).matching(identifier: "issue-title-input").firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        title.typeText("Simulator issue created")
        app.buttons["issue-save"].tap()
        XCTAssertTrue(app.staticTexts["Simulator issue created"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testRelatedIssueNavigation() throws {
        let app = launchFixture()
        let first = app.buttons["issue-row-PW-248"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap()
        app.buttons["issue-tab-Comments"].tap()
        let comment = app.descendants(matching: .any).matching(identifier: "issue-comment-input").firstMatch
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Keep this parent draft")
        selectIssueTab("Sub-issues", in: app)
        let child = app.buttons["Reconnect remote sessions"]
        XCTAssertTrue(child.waitForExistence(timeout: 5))
        child.tap()
        XCTAssertTrue(app.navigationBars["PW-249"].waitForExistence(timeout: 5))
        app.navigationBars["PW-249"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["PW-248"].waitForExistence(timeout: 5))
        XCTAssertTrue(child.waitForExistence(timeout: 5))
        selectIssueTab("Comments", in: app)
        XCTAssertEqual(comment.value as? String, "Keep this parent draft")
        app.navigationBars["PW-248"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["agent-orchestrator-button"].isHittable)
    }

    @MainActor
    func testSearchAndSecondaryControlsStayOutOfTheList() throws {
        let app = launchFixture()
        XCTAssertTrue(app.buttons["Issue actions"].waitForExistence(timeout: 10))
        app.buttons["Issue actions"].tap()
        app.buttons["Search"].tap()
        let search = app.textFields["Search issues"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Calendar")
        XCTAssertTrue(app.buttons["issue-row-PW-248"].exists)
        XCTAssertFalse(app.buttons["issue-row-PW-249"].exists)
        app.buttons["Close search"].tap()
        XCTAssertTrue(app.buttons["issue-row-PW-249"].waitForExistence(timeout: 5))
        app.buttons["Filter and display options"].tap()
        XCTAssertTrue(app.navigationBars["Filter and display"].waitForExistence(timeout: 5))
        capture(app, name: "Filters and display sheet")
        app.buttons["Done"].tap()
        app.buttons["Issue actions"].tap()
        app.buttons["Projects, milestones and cycles"].tap()
        XCTAssertTrue(app.buttons["New milestone"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.segmentedControls.buttons["Cycles"].exists)
    }

    @MainActor
    func testLongPressExposesIssueProperties() throws {
        let app = launchFixture()
        let row = app.buttons["issue-row-PW-248"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Assignee"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Status"].exists)
        XCTAssertTrue(app.buttons["Priority"].exists)
        XCTAssertTrue(app.buttons["Due date"].exists)
        capture(app, name: "Issue contextual actions")
        app.buttons["Status"].tap()
        app.buttons["In progress"].tap()
        let changed = app.buttons["issue-row-PW-248"]
        let updated = NSPredicate(format: "value CONTAINS %@", "In progress")
        expectation(for: updated, evaluatedWith: changed)
        waitForExpectations(timeout: 5)
    }

    @MainActor
    func testDragReordersAndMovesBetweenStatuses() throws {
        let app = launchFixture()
        let row = app.buttons["issue-row-PW-248"]
        let second = app.buttons["issue-row-PW-249"]
        let third = app.buttons["issue-row-PW-250"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.press(forDuration: 0.5, thenDragTo: third, withVelocity: .slow, thenHoldForDuration: 0.3)
        let reordered = NSPredicate { _, _ in
            guard row.exists, second.exists else { return false }
            return row.frame.minY > second.frame.minY
        }
        expectation(for: reordered, evaluatedWith: row)
        waitForExpectations(timeout: 5)
        XCTAssertTrue((row.value as? String)?.contains("In review") == true)

        row.press(forDuration: 0.5, thenDragTo: app.buttons["issue-row-PW-255"], withVelocity: .slow, thenHoldForDuration: 0.3)
        let moved = NSPredicate(format: "value CONTAINS %@", "In progress")
        expectation(for: moved, evaluatedWith: row)
        waitForExpectations(timeout: 5)
        capture(app, name: "Issue dragged into another status")
        row.tap()
        XCTAssertTrue(app.navigationBars["PW-248"].waitForExistence(timeout: 5))
        app.navigationBars["PW-248"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue((row.value as? String)?.contains("In progress") == true)
    }

    @MainActor
    func testBoardDragReordersIssues() throws {
        let app = launchFixture()
        XCTAssertTrue(app.buttons["Filter and display options"].waitForExistence(timeout: 10))
        app.buttons["Filter and display options"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Layout")).firstMatch.tap()
        app.buttons["Board"].tap()
        app.buttons["Done"].tap()
        XCTAssertTrue(app.scrollViews["issues-board"].waitForExistence(timeout: 5))
        let row = app.buttons["issue-row-PW-248"]
        let second = app.buttons["issue-row-PW-249"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.press(forDuration: 0.5, thenDragTo: app.buttons["issue-row-PW-250"], withVelocity: .slow, thenHoldForDuration: 0.3)
        let reordered = NSPredicate { _, _ in
            guard row.exists, second.exists else { return false }
            return row.frame.minY > second.frame.minY
        }
        expectation(for: reordered, evaluatedWith: row)
        waitForExpectations(timeout: 5)
        capture(app, name: "Board issue reordered")
        let target = app.buttons["issue-row-PW-255"]
        XCTAssertTrue(target.exists)
        let visibleTargetX = min(target.frame.maxX, app.frame.maxX) - 16
        XCTAssertGreaterThan(visibleTargetX, target.frame.minX)
        let destination = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: visibleTargetX, dy: target.frame.midY))
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.5, thenDragTo: destination, withVelocity: .slow, thenHoldForDuration: 0.3)
        expectation(for: NSPredicate(format: "value CONTAINS %@", "In progress"), evaluatedWith: row)
        waitForExpectations(timeout: 5)
    }

    @MainActor
    func testIssueTabsAndOwnedSubviews() throws {
        let app = launchFixture()
        let issue = app.buttons["issue-row-PW-248"]
        XCTAssertTrue(issue.waitForExistence(timeout: 10))
        issue.tap()
        XCTAssertTrue(app.navigationBars["PW-248"].waitForExistence(timeout: 5))
        app.buttons["issue-tab-Comments"].tap()
        capture(app, name: "Issue comments tab")
        app.buttons["issue-tab-Attachments"].tap()
        capture(app, name: "Issue attachments tab")
        selectIssueTab("Sub-issues", in: app)
        XCTAssertTrue(app.buttons["Reconnect remote sessions"].waitForExistence(timeout: 5))
        capture(app, name: "Issue sub-issues tab")
        selectIssueTab("AI", in: app)
        capture(app, name: "Issue AI tab")
        app.buttons["issue-ai-controls"].tap()
        XCTAssertTrue(app.navigationBars["Agent work"].waitForExistence(timeout: 5))
        capture(app, name: "Issue AI controls subview")
        XCTAssertFalse(app.buttons["issue-detail-done"].exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["PW-248"].waitForExistence(timeout: 5))
        selectIssueTab("Activity", in: app)
        capture(app, name: "Issue activity tab")
    }

    @MainActor
    private func selectIssueTab(_ name: String, in app: XCUIApplication) {
        let tab = app.buttons["issue-tab-\(name)"]
        let strip = app.scrollViews["issue-tabs"]
        if !tab.isHittable {
            if name == "Details" || name == "Comments" { strip.swipeRight() }
            else { strip.swipeLeft() }
        }
        XCTAssertTrue(tab.isHittable)
        tab.tap()
    }

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    @MainActor
    private func launchFixture() -> XCUIApplication {
        addUIInterruptionMonitor(withDescription: "Simulator Apple Account verification") { alert in
            guard alert.staticTexts["Apple Account Verification"].exists,
                  alert.buttons["Not Now"].exists else { return false }
            alert.buttons["Not Now"].tap()
            return true
        }
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-issues"]
        app.launch()
        let systemAlert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if systemAlert.staticTexts["Apple Account Verification"].exists,
           systemAlert.buttons["Not Now"].exists {
            systemAlert.buttons["Not Now"].tap()
        }
        return app
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
