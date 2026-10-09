import XCTest

/// Runs the adaptive thread shell against deterministic model adapters.
/// These checks prove native interactions, not cloud authorization or remote server delivery.
final class PathwayParityUITests: XCTestCase {
    @MainActor func testThreadRefreshFinishesWhenCloudIsUnavailable() {
        let app = launch(extra: ["--parity-thread-menu"])
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let start = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        let end = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
        let result = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Couldn’t refresh threads.")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertTrue(result.label.contains("Couldn’t refresh threads"))
        XCTAssertTrue(app.navigationBars["Agent Threads"].exists)
        XCTAssertEqual(app.activityIndicators.count, 0)
        capture(app, "Thread refresh finishes with an offline result")
    }

    @MainActor func testThreadSearchOpensAtTopAndCancels() {
        let app = launch(extra: ["--parity-thread-menu"])
        let field = app.textFields["agent-threads-search"]
        XCTAssertFalse(field.exists)
        XCTAssertEqual(app.searchFields.count, 0)
        capture(app, "Thread list without bottom search")
        app.buttons["Thread options"].tap()
        app.buttons["Search"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertLessThan(field.frame.maxY, app.frame.height / 2)
        field.typeText("Astro")
        XCTAssertEqual(field.value as? String, "Astro")
        XCTAssertTrue(app.staticTexts["Five Astro Web Designs"].exists)
        XCTAssertFalse(app.staticTexts["Review Billing For Missing Stripe IDs"].exists)
        capture(app, "Top search focused with keyboard")
        app.buttons["agent-threads-search-cancel"].tap()
        XCTAssertFalse(field.exists)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.buttons["Thread options"].tap()
        app.buttons["Search"].tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(field.value as? String, "Search threads")
    }

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        executionTimeAllowance = 120
    }

    @MainActor private func launch(extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-parity"] + extra
        app.launch()
        XCTAssertTrue(app.navigationBars["Agent Threads"].firstMatch.waitForExistence(timeout: 10))
        return app
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
