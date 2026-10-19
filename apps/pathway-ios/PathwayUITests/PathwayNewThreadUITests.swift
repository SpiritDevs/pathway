import XCTest

final class PathwayNewThreadUITests: XCTestCase {
    @MainActor
    func testLongAttachedDraftKeepsControlsAboveKeyboard() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["--uitest-new-thread"]
        app.launch()
        let field = app.textViews["new-agent-thread-prompt"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(" More context.")
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        assertControls(app, above: keyboard)
        capture(app, "Long draft and attachment with keyboard")

        app.buttons["new-agent-thread-options"].tap()
        XCTAssertTrue(app.navigationBars["Composer Options"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func assertControls(_ app: XCUIApplication, above keyboard: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        for identifier in ["new-agent-thread-options", "new-agent-thread-model-picker", "Start agent thread"] {
            let control = app.buttons[identifier]
            XCTAssertTrue(control.isHittable, identifier, file: file, line: line)
            XCTAssertTrue(control.isEnabled, identifier, file: file, line: line)
            XCTAssertLessThanOrEqual(control.frame.maxY, keyboard.frame.minY, identifier, file: file, line: line)
        }
    }

    @MainActor
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
