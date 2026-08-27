import XCTest

final class PathwayUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app = nil
    }

    @MainActor
    func testTappingDocumentPresentsInformationTabs() {
        launchFixture()
        firstDocument.tap()

        XCTAssertTrue(app.navigationBars["Document Information"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.segmentedControls.buttons["General"].exists)
        XCTAssertTrue(app.segmentedControls.buttons["History"].exists)
        XCTAssertTrue(app.segmentedControls.buttons["Versions"].exists)
        XCTAssertTrue(app.segmentedControls.buttons["Recipients"].exists)
        XCTAssertTrue(app.buttons["Share"].exists)
        XCTAssertTrue(app.buttons["Send"].exists)

        app.segmentedControls.buttons["History"].tap()
        XCTAssertTrue(app.staticTexts["No History Yet"].waitForExistence(timeout: 2))

        app.segmentedControls.buttons["Versions"].tap()
        XCTAssertTrue(app.staticTexts["No Versions Yet"].waitForExistence(timeout: 2))

        app.segmentedControls.buttons["Recipients"].tap()
        XCTAssertTrue(app.staticTexts["No Recipients"].waitForExistence(timeout: 2))

        app.buttons["Add Recipient"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Add Recipient"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["Pathway Contacts"].exists)
        XCTAssertTrue(app.buttons["Phone Contacts"].exists)
    }

    @MainActor
    func testLeadingSwipePinsAndUnpinsDocument() {
        launchFixture()
        firstDocument.swipeRight()
        let pin = app.buttons["Pin"]
        XCTAssertTrue(pin.waitForExistence(timeout: 2))
        pin.tap()

        XCTAssertTrue(pin.waitForNonExistence(timeout: 2))
        firstDocument.swipeRight()
        let unpin = app.buttons["Unpin"]
        XCTAssertTrue(unpin.waitForExistence(timeout: 2))
        unpin.tap()
    }

    @MainActor
    func testTrailingSwipeMovesDocumentToTrashAndOffersUndo() {
        launchFixture()
        firstDocument.swipeLeft()
        let trash = app.buttons["Move to Trash"]
        XCTAssertTrue(trash.waitForExistence(timeout: 2))
        trash.tap()

        let undo = app.buttons["undo-document-archive"]
        XCTAssertTrue(undo.waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Quarterly Proposal moved to Trash"].exists)
        undo.tap()
        XCTAssertFalse(undo.exists)
    }

    @MainActor
    func testLongPressShowsDocumentActions() {
        launchFixture()
        firstDocument.press(forDuration: 1.2)

        XCTAssertTrue(app.buttons["Share Document"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["Transfer Document"].exists)
        XCTAssertTrue(app.buttons["Send Document"].exists)
    }

    @MainActor
    func testSendSheetOffersScheduledDelivery() {
        launchFixture()
        firstDocument.tap()
        XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 2))
        app.buttons["Send"].tap()

        XCTAssertTrue(app.navigationBars["Send Document"].waitForExistence(timeout: 3))
        app.swipeUp()
        app.swipeUp()
        app.swipeUp()
        let deliveryTime = app.segmentedControls["send-document-delivery-time"]
        XCTAssertTrue(deliveryTime.waitForExistence(timeout: 2))
        deliveryTime.buttons["Later"].tap()
        app.swipeUp()
        XCTAssertTrue(app.datePickers["send-document-scheduled-at"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["Schedule"].exists)
    }

    @MainActor
    private func launchFixture() {
        app = XCUIApplication()
        app.launchArguments += ["--ui-testing-document-interactions"]
        app.launch()
        XCTAssertTrue(firstDocument.waitForExistence(timeout: 5))
    }

    @MainActor
    private var firstDocument: XCUIElement {
        app.descendants(matching: .any)["document-row-ui-test-document-1"]
    }
}
