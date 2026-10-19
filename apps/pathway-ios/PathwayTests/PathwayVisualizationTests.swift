import Foundation
import Testing
@testable import Pathway

struct PathwayVisualizationTests {
    @Test func parsesHistoricalReferencesAndWindowsPaths() throws {
        let historical = try #require(PathwayVisualization.parse(#"visualize{"path":"/tmp/pathway-background-services-97f9e984/background-services.html"}"#))
        #expect(historical.title == "background services")
        let windows = try #require(PathwayVisualization.parse(#"visualize{"path":"C:\\scratch\\mockup.html","title":"Service preview","mode":"wide"}"#))
        #expect(windows.path == #"C:\scratch\mockup.html"#)
        #expect(windows.title == "Service preview")
    }

    @Test func leavesExamplesAndInvalidReferencesAlone() {
        for text in [#"`visualize{"path":"/tmp/a.html"}`"#, "visualize{", #"visualize{"path":"https://example.com/a.html"}"#,
                     #"visualize{"path":"/tmp/secret.txt"}"#, #"visualize{"path":"/tmp/a\u0000.html"}"#] {
            #expect(PathwayVisualization.parse(text) == nil)
        }
    }
}
