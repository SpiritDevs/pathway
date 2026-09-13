import SwiftUI

/// A dense issue list: the title and one scope row are the only persistent chrome.
struct PathwayIssuesView: View {
    let model: PathwayIssuesModel
    let companies: [PathwayCompany]
    let projects: [PathwayCompanyProject]
    let onOpenPlanning: (String) -> Void

    @State private var selectedCompanyID: String?
    @State private var scope: PathwayIssueListScope = .all
    @State private var configuration = PathwayIssueListConfiguration()
    @State private var query = ""
    @State private var showsSearch = false
    @State private var showsFilters = false
    @State private var showsSavedViews = false
    @State private var showsSaveView = false
    @State private var savedViewName = ""
    @State private var activeViewID: String?
    @State private var renamingViewID: String?
    @State private var renameText = ""
    @State private var agentIssues: [PathwayIssueRecord] = []
    @State private var dueDateIssue: PathwayIssueRecord?
    @State private var workIssue: PathwayIssueRecord?
    @State private var presentation: IssuePresentation?
    @State private var openedIssue: IssueNavigationDestination?
    @State private var isSelecting = false
    @State private var selectedIDs: Set<String> = []
    @State private var pendingDelete: [PathwayIssueRecord] = []
    @State private var errorMessage: String?
    @FocusState private var searchFocused: Bool

    init(
        model: PathwayIssuesModel, companies: [PathwayCompany], projects: [PathwayCompanyProject],
        initialScope: PathwayIssueListScope = .all,
        onOpenPlanning: @escaping (String) -> Void
    ) {
        self.model = model
        self.companies = companies
        self.projects = projects
        self.onOpenPlanning = onOpenPlanning
        _scope = State(initialValue: initialScope)
    }

    private var companyID: String? { companies.first { $0.id == selectedCompanyID }?.id ?? companies.first?.id }
    private var company: PathwayCompany? { companies.first { $0.id == companyID } }
    private var statuses: [PathwayIssueEntity] { model.statuses.filter { $0.companyId == companyID } }
    private var labels: [PathwayIssueEntity] { model.labels.filter { $0.companyId == companyID } }
    private var views: [PathwayIssueEntity] {
        model.views.filter { $0.companyId == companyID }.sorted {
            $0.position == $1.position ? $0.id < $1.id : $0.position < $1.position
        }
    }
    private var companyProjects: [PathwayCompanyProject] { projects.filter { $0.companyId == companyID } }
    private var companyRecords: [PathwayIssueRecord] { model.records.filter { $0.companyId == companyID } }
    private var selectedIssues: [PathwayIssueRecord] { visibleIssues.filter { selectedIDs.contains($0.id) } }

    private var visibleIssues: [PathwayIssueRecord] {
        let statusCategories = Dictionary(uniqueKeysWithValues: statuses.map { ($0.id, $0.category) })
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let today = Date()
        return companyRecords.filter { issue in
            guard !issue.isDeleted, issue.triage == (scope == .triage) else { return false }
            if !needle.isEmpty && !(issue.title + " " + issue.key + " " + issue.description).localizedStandardContains(needle) {
                return false
            }
            if scope == .triage { return true }
            if scope == .mine {
                let token = PathwayIssueListConfiguration.assigneeToken(issue.assignee)
                guard token == "user" || token == company.map({ "member:\($0.membershipId)" }) else { return false }
            }
            return configuration.matches(issue, category: statusCategories[issue.statusId], currentMembershipID: company?.membershipId, today: today)
        }.sorted(by: compareIssues)
    }

    private var groups: [IssueListGroup] {
        let issues = visibleIssues
        let grouping = scope == .triage ? "none" : configuration.viewMode == "board" ? "status" : configuration.grouping
        if grouping == "none" { return [IssueListGroup(id: "all", title: "", statusID: nil, issues: issues)] }
        if grouping == "status" {
            let grouped = Dictionary(grouping: issues, by: \.statusId)
            var result: [IssueListGroup] = statuses.sorted { $0.position == $1.position ? $0.id < $1.id : $0.position < $1.position }.compactMap { status in
                let rows = grouped[status.id] ?? []
                if configuration.tab == "active" && !["unstarted", "started", "review"].contains(status.category) { return nil }
                if configuration.tab == "backlog" && status.category != "backlog" { return nil }
                return IssueListGroup(id: status.id, title: status.name, statusID: status.id, issues: rows)
            }
            let knownIDs = Set(statuses.map(\.id))
            let unknown = issues.filter { !knownIDs.contains($0.statusId) }
            if !unknown.isEmpty { result.append(.init(id: "unknown-status", title: "Other issues", statusID: nil, issues: unknown)) }
            return result
        }
        let grouped = Dictionary(grouping: issues) { issue in
            switch grouping {
            case "priority": issue.priority
            case "project": issue.projectId ?? "unassigned"
            default: PathwayIssueListConfiguration.assigneeToken(issue.assignee) ?? "unassigned"
            }
        }
        return grouped.map { key, rows in
            let title: String
            switch grouping {
            case "priority": title = priorityTitle(key)
            case "project": title = companyProjects.first { $0.project.id == key }?.project.name ?? "No project"
            default: title = assigneeName(key)
            }
            return IssueListGroup(id: key, title: title, statusID: nil, issues: rows)
        }.sorted {
            if grouping == "priority" { return priorityRank($0.id) < priorityRank($1.id) }
            return $0.title.localizedStandardCompare($1.title) == .orderedAscending
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            scopeBar
            if showsSearch { searchField }
            if let message = errorMessage ?? model.errorMessage { errorBanner(message) }
            issueContent
        }
        .background(.background)
        .toolbarVisibility(.hidden, for: .navigationBar)
        .accessibilityIdentifier(configuration.viewMode == "board" && scope != .triage ? "issues-board" : "issues-native-list")
        .navigationDestination(item: $openedIssue) { destination in
            PathwayIssueDetailView(model: model, companyID: destination.companyID, issueID: destination.issueID)
                .preference(key: IssueDetailNavigationActiveKey.self, value: true)
        }
        .sheet(item: $presentation) { destination in
            PathwayIssueEditorView(model: model, companyID: destination.companyID, issueID: destination.issueID, parentID: destination.parentID, defaultStatusID: destination.statusID)
        }
        .sheet(isPresented: $showsFilters) { filterSheet }
        .sheet(isPresented: $showsSavedViews) { savedViewsSheet }
        .sheet(item: $dueDateIssue) { issue in PathwayIssueDueDateSheet(model: model, issue: issue, selection: contextIssues(issue)) }
        .sheet(item: $workIssue) { issue in PathwayIssueWorkView(model: model, issue: issue) }
        .sheet(isPresented: Binding(get: { !agentIssues.isEmpty }, set: { if !$0 { agentIssues = [] } })) {
            PathwayIssueBulkAgentView(model: model, issues: agentIssues)
        }
        .alert("Save view", isPresented: $showsSaveView) {
            TextField("View name", text: $savedViewName)
            Button("Cancel", role: .cancel) {}
            Button("Save") { saveView() }
                .disabled(savedViewName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: { Text("Save these filters, grouping and layout to return to them later.") }
        .confirmationDialog("Delete \(pendingDelete.count) \(pendingDelete.count == 1 ? "issue" : "issues")?", isPresented: Binding(get: { !pendingDelete.isEmpty }, set: { if !$0 { pendingDelete = [] } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                let issues = pendingDelete
                pendingDelete = []
                perform {
                    for issue in issues { try await model.remove(issue) }
                    selectedIDs.subtract(issues.map(\.id))
                }
            }
        } message: { Text("Deleted issues can be restored from Recently deleted.") }
        .onChange(of: companyID) { resetView() }
        .onChange(of: scope) { selectedIDs = []; isSelecting = false }
        .onChange(of: visibleIssues.map(\.id)) { _, visibleIDs in
            selectedIDs.formIntersection(visibleIDs)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(companies) { company in
                    Button {
                        selectedCompanyID = company.id
                    } label: {
                        if company.id == companyID { Label(company.name, systemImage: "checkmark") }
                        else { Text(company.name) }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(scope.title).font(.title2.bold())
                    if companies.count > 1 { Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                }
                .foregroundStyle(.primary)
                .frame(minHeight: 44)
            }
            .accessibilityLabel("\(scope.title), \(company?.name ?? "Choose company")")
            Spacer(minLength: 8)
            HStack(spacing: 0) {
                Button { openEditor() } label: { Image(systemName: "square.and.pencil").frame(width: 44, height: 44) }
                    .accessibilityLabel("New issue")
                    .disabled(companyID == nil)
                overflowMenu
            }
            .font(.title3)
            .foregroundStyle(.primary)
            .background(.quaternary.opacity(0.45), in: Capsule())
        }
        .buttonStyle(.plain)
        .tint(Color.primary)
        .padding(.horizontal, 18)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }

    private var scopeBar: some View {
        HStack(spacing: 2) {
            ForEach(PathwayIssueListScope.allCases) { item in
                HStack(spacing: 0) {
                    Button { scope = item } label: {
                        Text(item == .all ? "All" : item == .mine ? "My issues" : "Triage")
                            .font(.subheadline.weight(scope == item ? .semibold : .regular))
                            .foregroundStyle(scope == item ? .primary : .secondary)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 40)
                    }
                    .accessibilityAddTraits(scope == item ? .isSelected : [])
                    if scope == item && item != .triage {
                        Button { showsFilters = true } label: {
                            Image(systemName: configuration.filterCount > 0 ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease")
                                .font(.subheadline)
                                .frame(width: 36, height: 40)
                                .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 1, height: 16) }
                        }
                        .accessibilityLabel(configuration.filterCount > 0 ? "Filters, \(configuration.filterCount) active" : "Filter and display options")
                    }
                }
                .background(scope == item ? Color.primary.opacity(0.045) : .clear, in: Capsule())
            }
            Spacer(minLength: 0)
        }
        .buttonStyle(.plain)
        .tint(Color.primary)
        .padding(.horizontal, 14)
        .padding(.bottom, 4)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search issues", text: $query).focused($searchFocused).submitLabel(.search)
            Button {
                query = ""; showsSearch = false
            } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                .accessibilityLabel("Close search")
        }
        .padding(10)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: 10))
        .padding(.horizontal, 18)
        .padding(.bottom, 8)
        .onAppear { searchFocused = true }
    }

    private var overflowMenu: some View {
        Menu {
            Button("Search", systemImage: "magnifyingglass") { showsSearch = true }
            if scope != .triage {
                Button("Filter and display", systemImage: "line.3.horizontal.decrease") { showsFilters = true }
                Button("Saved views", systemImage: "star") { showingDeleted = false; showsSavedViews = true }
            }
            Button(isSelecting ? "Done selecting" : "Select issues", systemImage: "checkmark.circle") {
                isSelecting.toggle(); selectedIDs = []
            }
            if isSelecting {
                Button("Select all visible") { selectedIDs = Set(visibleIssues.prefix(500).map(\.id)) }
            }
            Divider()
            if let companyID {
                Button("Projects, milestones and cycles", systemImage: "calendar") { onOpenPlanning(companyID) }
                Button("Recently deleted", systemImage: "trash") { showingDeleted = true; showsSavedViews = true }
            }
        } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
        .accessibilityLabel("Issue actions")
    }

    @ViewBuilder private var issueContent: some View {
        if companyID == nil {
            ContentUnavailableView("No company selected", systemImage: "building.2", description: Text("Connect to a company to see its issues."))
        } else if visibleIssues.isEmpty {
            ContentUnavailableView {
                Label(scope == .triage ? "Triage is clear" : "No issues", systemImage: scope == .triage ? "tray" : "checklist")
            } description: {
                Text(query.isEmpty && configuration.filterCount == 0 ? "New issues will appear here." : "Try another search or clear your filters.")
            } actions: {
                if configuration.filterCount > 0 || !query.isEmpty {
                    Button("Clear filters") { configuration = .init(); query = "" }
                }
                Button("Create issue") { openEditor() }
            }
        } else if configuration.viewMode == "board" && scope != .triage {
            board
        } else {
            issueList
        }
    }

    private var issueList: some View {
        let rows = groups.flatMap { group in
            (group.title.isEmpty ? [] : [IssueListRow.header(group)]) + group.issues.map(IssueListRow.issue)
        }
        return List {
            ForEach(rows) { row in
                Group {
                    switch row {
                    case .header(let group):
                        groupHeader(group)
                    case .issue(let issue):
                        issueRow(issue, acceptsRowDrop: false)
                            .itemProvider {
                                guard dragOrderingEnabled, !issue.triage else { return nil }
                                return PathwayIssueDragPayload(companyID: issue.companyId, issueID: issue.id).itemProvider()
                            }
                    }
                }
                .moveDisabled(!dragOrderingEnabled || row.issue == nil)
                .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
                .listRowSeparator(.hidden)
            }
            .onMove { offsets, destination in
                guard dragOrderingEnabled, offsets.count == 1, let index = offsets.first,
                      rows.indices.contains(index), let issue = rows[index].issue,
                      let position = PathwayIssueListDropPosition.resolve(entries: rows.map(\.dropEntry), sourceID: issue.id, destination: destination) else { return }
                handleDrop(.init(companyID: issue.companyId, issueID: issue.id), targetStatusID: position.statusID,
                           targetIssueID: position.targetIssueID, edge: position.edge)
            }
            .onInsert(of: dragOrderingEnabled ? [PathwayIssueDragPayload.contentType] : []) { index, providers in
                guard dragOrderingEnabled else { return }
                PathwayIssueDragPayload.load(from: providers) { payload in
                    guard let position = PathwayIssueListDropPosition.resolve(entries: rows.map(\.dropEntry), sourceID: payload.issueID, destination: index) else { return }
                    handleDrop(payload, targetStatusID: position.statusID, targetIssueID: position.targetIssueID, edge: position.edge)
                }
            }
        }
        .listStyle(.plain)
        .contentMargins(.top, 0, for: .scrollContent)
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom, spacing: 0) { if isSelecting { selectionBar } }
    }

    private var board: some View {
        ScrollView(.horizontal) {
            LazyHStack(alignment: .top, spacing: 12) {
                ForEach(groups) { group in
                    VStack(spacing: 0) {
                        groupHeader(group).padding(.horizontal, 12)
                        ScrollView {
                            LazyVStack(spacing: 1) {
                                ForEach(group.issues, id: \.id) { issue in
                                    issueRow(issue).padding(.horizontal, 12)
                                }
                            }
                        }
                    }
                    .frame(width: 310)
                    .background(.quaternary.opacity(0.25), in: .rect(cornerRadius: 14))
                }
            }
            .padding(.horizontal, 18)
        }
        .scrollTargetBehavior(.viewAligned)
        .safeAreaInset(edge: .bottom, spacing: 0) { if isSelecting { selectionBar } }
    }

    private func groupHeader(_ group: IssueListGroup) -> some View {
        HStack {
            Text(group.title).font(.subheadline.weight(.medium)).foregroundStyle(Color.secondary)
            Spacer()
            Button { openEditor(statusID: group.statusID) } label: {
                Image(systemName: "plus").font(.subheadline).foregroundStyle(Color.secondary).frame(width: 36, height: 36)
            }
            .accessibilityLabel("Add issue to \(group.title)")
        }
        .buttonStyle(.plain)
        .tint(Color.primary)
        .textCase(nil)
        .modifier(PathwayIssueDropTarget(enabled: dragOrderingEnabled && group.statusID != nil, isHeader: true) { payload, edge in
            guard let statusID = group.statusID else { return }
            handleDrop(payload, targetStatusID: statusID, targetIssueID: nil, edge: edge)
        })
        .accessibilityIdentifier("issue-status-\(group.statusID ?? group.id)")
    }

    private func issueRow(_ issue: PathwayIssueRecord, acceptsRowDrop: Bool = true) -> some View {
        Button {
            if isSelecting { toggleSelection(issue.id) }
            else { openedIssue = .init(companyID: issue.companyId, issueID: issue.id) }
        } label: {
            HStack(spacing: 10) {
                if isSelecting {
                    Image(systemName: selectedIDs.contains(issue.id) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selectedIDs.contains(issue.id) ? Color.accentColor : .secondary)
                        .frame(width: 18)
                } else {
                    PathwayIssueStatusGlyph(category: issue.triage ? "triage" : statuses.first { $0.id == issue.statusId }?.category ?? "unstarted", hexColor: statuses.first { $0.id == issue.statusId }?.color)
                }
                Text(issue.title)
                    .font(.body)
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                PathwayIssueAssigneeGlyph(token: PathwayIssueListConfiguration.assigneeToken(issue.assignee), name: assigneeAvatarName(issue))
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(issue.key), \(issue.title)")
        .accessibilityValue("\(issue.triage ? "Triage" : statuses.first { $0.id == issue.statusId }?.name ?? "Unknown status"), \(priorityTitle(issue.priority)), \(assigneeName(PathwayIssueListConfiguration.assigneeToken(issue.assignee) ?? "unassigned"))")
        .accessibilityIdentifier("issue-row-\(issue.key)")
        .accessibilityAddTraits(isSelecting && selectedIDs.contains(issue.id) ? .isSelected : [])
        .modifier(PathwayIssueDragSource(payload: .init(companyID: issue.companyId, issueID: issue.id), enabled: acceptsRowDrop && dragOrderingEnabled && !issue.triage))
        .contextMenu { rowMenu(issue) }
        .modifier(PathwayIssueDropTarget(enabled: acceptsRowDrop && dragOrderingEnabled && !issue.triage) { payload, edge in
            handleDrop(payload, targetStatusID: issue.statusId, targetIssueID: issue.id, edge: edge)
        })
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Delete", role: .destructive) { pendingDelete = [issue] }
            Button("Edit") { presentation = .init(companyID: issue.companyId, issueID: issue.id) }.tint(.blue)
        }
    }

    @ViewBuilder private func rowMenu(_ issue: PathwayIssueRecord) -> some View {
        let targets = contextIssues(issue)
        if issue.triage {
            Menu("Accept", systemImage: "checkmark") {
                ForEach(statuses, id: \.id) { status in
                    Button(status.name) { acceptTriage(targets, statusID: status.id) }
                }
            }
            Button("Decline", systemImage: "xmark", role: .destructive) { rejectTriage(targets) }
        } else {
            Menu("Status", systemImage: "circle.dotted") {
                ForEach(statuses, id: \.id) { status in
                    Button(status.name) { update(targets, patch: ["statusId": .string(status.id)]) }
                }
            }
            priorityMenu(targets)
            PathwayIssueRowPropertyMenus(model: model, issue: issue, selection: targets, companies: companies, projects: projects,
                chooseDueDate: { dueDateIssue = issue }, onError: { errorMessage = $0 })
            if manualOrderingEnabled && targets.count == 1 {
                Menu("Move", systemImage: "arrow.up.arrow.down") {
                    Button("Move to top") { moveIssue(issue, destination: .top) }
                    Button("Move up") { moveIssue(issue, destination: .up) }
                    Button("Move down") { moveIssue(issue, destination: .down) }
                    Button("Move to bottom") { moveIssue(issue, destination: .bottom) }
                }
            } else if !manualOrderingEnabled {
                Button("Enable drag ordering", systemImage: "arrow.up.arrow.down") {
                    configuration.grouping = "status"
                    configuration.sortMode = "manual"
                }
            }
        }
        if issue.triage {
            priorityMenu(targets)
            PathwayIssueRowPropertyMenus(model: model, issue: issue, selection: targets, companies: companies, projects: projects,
                chooseDueDate: { dueDateIssue = issue }, onError: { errorMessage = $0 })
        }
        Divider()
        if targets.count == 1 {
            Button("Open", systemImage: "doc.text") { openedIssue = .init(companyID: issue.companyId, issueID: issue.id) }
            Button("Start work", systemImage: "play") { workIssue = issue }
            Button("Edit", systemImage: "pencil") { presentation = .init(companyID: issue.companyId, issueID: issue.id) }
            Button("Add sub-issue", systemImage: "list.bullet.indent") { presentation = .init(companyID: issue.companyId, parentID: issue.id) }
        }
        Button("Ask AI or investigate", systemImage: "sparkles") { agentIssues = targets }
        Button("Select", systemImage: "checkmark.circle") { isSelecting = true; selectedIDs.insert(issue.id) }
        Divider()
        Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = targets }
    }

    private var selectionBar: some View {
        HStack {
            Text("\(selectedIDs.count) selected").font(.subheadline).monospacedDigit()
            Spacer()
            Menu {
                if scope == .triage {
                    Menu("Accept") {
                        ForEach(statuses, id: \.id) { status in Button(status.name) { acceptTriage(selectedIssues, statusID: status.id) } }
                    }
                    Button("Decline", role: .destructive) { rejectTriage(selectedIssues) }
                } else {
                    Menu("Status") {
                        ForEach(statuses, id: \.id) { status in Button(status.name) { update(selectedIssues, patch: ["statusId": .string(status.id)]) } }
                    }
                    priorityMenu(selectedIssues)
                    Menu("Labels") {
                        ForEach(labels, id: \.id) { label in
                            let allHaveLabel = selectedIssues.allSatisfy { $0.labelIds.contains(label.id) }
                            Button("\(allHaveLabel ? "Remove" : "Add") \(label.name)") { toggleLabel(label.id, issues: selectedIssues, remove: allHaveLabel) }
                        }
                    }
                }
                Button("Ask AI or investigate", systemImage: "sparkles") { agentIssues = selectedIssues }
                Button("Delete", role: .destructive) { pendingDelete = selectedIssues }
            } label: { Label("Actions", systemImage: "ellipsis.circle").frame(minHeight: 44) }
            .disabled(selectedIDs.isEmpty || model.isWriting)
            Button("Done") { isSelecting = false; selectedIDs = [] }.frame(minHeight: 44)
        }
        .padding(.horizontal, 18)
        .background(.regularMaterial)
    }

    private func contextIssues(_ issue: PathwayIssueRecord) -> [PathwayIssueRecord] {
        isSelecting && selectedIDs.count > 1 && selectedIDs.contains(issue.id) ? selectedIssues : [issue]
    }

    private func priorityMenu(_ issues: [PathwayIssueRecord]) -> some View {
        Menu("Priority", systemImage: "flag") {
            ForEach(PathwayIssueListConfiguration.priorityOrder, id: \.self) { priority in
                Button(priorityTitle(priority)) { update(issues, patch: ["priority": .string(priority)]) }
            }
        }
    }

    private var manualOrderingEnabled: Bool {
        configuration.sortMode == "manual" && (configuration.viewMode == "board" || configuration.grouping == "status")
    }

    private var dragOrderingEnabled: Bool { scope != .triage && manualOrderingEnabled && !isSelecting }

    private func handleDrop(_ payload: PathwayIssueDragPayload, targetStatusID: String, targetIssueID: String?, edge: PathwayIssueDropEdge) {
        guard dragOrderingEnabled, let companyID,
              let move = PathwayIssueDropOrdering.resolve(
                payload: payload, companyID: companyID, records: visibleIssues,
                statusIDs: Set(statuses.map(\.id)), targetStatusID: targetStatusID,
                targetIssueID: targetIssueID, edge: edge
              ), let issue = model.records.first(where: { $0.companyId == companyID && $0.id == move.issueID }) else {
            return
        }
        perform {
            try await model.setSortOrder(issue, sortOrder: move.sortOrder, statusID: move.statusID)
        }
    }

    private func moveIssue(_ issue: PathwayIssueRecord, destination: IssueMoveDestination) {
        let source = groups.first { $0.statusID == issue.statusId }?.issues ?? []
        guard let originalIndex = source.firstIndex(where: { $0.id == issue.id }) else { return }
        let siblings = source.filter { $0.id != issue.id }
        let index: Int
        switch destination {
        case .top: index = 0
        case .up: index = max(0, originalIndex - 1)
        case .down: index = min(siblings.count, originalIndex + 1)
        case .bottom: index = siblings.count
        }
        guard index != originalIndex else { return }
        let before = index > 0 ? siblings[index - 1].sortOrder : nil
        let after = index < siblings.count ? siblings[index].sortOrder : nil
        guard let key = PathwayIssueOrdering.key(between: before, and: after) else {
            errorMessage = "These issues have an invalid manual order. Choose another sort order to continue."
            return
        }
        perform { try await model.setSortOrder(issue, sortOrder: key) }
    }

    private func compareIssues(_ lhs: PathwayIssueRecord, _ rhs: PathwayIssueRecord) -> Bool {
        let grouping = configuration.viewMode == "board" ? "status" : configuration.grouping
        let sort = configuration.sortMode == "manual" && grouping != "status" ? "priority" : configuration.sortMode
        if scope == .triage || sort == "created" {
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
        } else if sort == "updated" {
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
        } else {
            if sort == "priority" && lhs.priority != rhs.priority { return priorityRank(lhs.priority) < priorityRank(rhs.priority) }
            let left = lhs.fields["sortOrder"]?.stringValue ?? ""
            let right = rhs.fields["sortOrder"]?.stringValue ?? ""
            if left != right { return left < right }
        }
        return lhs.id < rhs.id
    }

    private func assigneeName(_ token: String) -> String {
        if token == "user" { return "You" }
        if token.hasPrefix("agent:") { return String(token.dropFirst(6)).capitalized }
        if token.hasPrefix("member:") {
            let id = String(token.dropFirst(7))
            if id == company?.membershipId { return "You" }
            return model.members.first { $0.companyId == companyID && $0.id == id }?.name ?? "Member"
        }
        return "Unassigned"
    }

    private func assigneeAvatarName(_ issue: PathwayIssueRecord) -> String {
        let token = PathwayIssueListConfiguration.assigneeToken(issue.assignee) ?? "unassigned"
        let membershipID = token == "user" ? company?.membershipId : token.hasPrefix("member:") ? String(token.dropFirst(7)) : nil
        if let membershipID, let member = model.members.first(where: { $0.companyId == issue.companyId && $0.id == membershipID }), !member.name.isEmpty {
            return member.name
        }
        return assigneeName(token)
    }

    private func priorityRank(_ priority: String) -> Int { PathwayIssueListConfiguration.priorityOrder.firstIndex(of: priority) ?? 5 }
    private func priorityTitle(_ priority: String) -> String { priority == "none" ? "No priority" : priority.capitalized }
    private func toggleSelection(_ id: String) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) }
        else if selectedIDs.count < 500 { selectedIDs.insert(id) }
    }
    private func resetView() {
        configuration = .init(); query = ""; selectedIDs = []; isSelecting = false; activeViewID = nil
        openedIssue = nil; presentation = nil; dueDateIssue = nil; workIssue = nil; agentIssues = []
    }
    private func openEditor(statusID: String? = nil) {
        guard let companyID else { return }
        presentation = .init(companyID: companyID, statusID: statusID)
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await operation(); errorMessage = nil }
            catch { errorMessage = error.localizedDescription }
        }
    }
    private func update(_ issues: [PathwayIssueRecord], patch: [String: JSONValue]) {
        perform { try await model.bulkUpdate(issues, patch: patch) }
    }
    private func toggleLabel(_ id: String, issues: [PathwayIssueRecord], remove: Bool) {
        perform {
            for issue in issues {
                let next = remove ? issue.labelIds.filter { $0 != id } : Array(Set(issue.labelIds + [id])).sorted()
                try await model.update(issue, patch: ["labelIds": .array(next.map(JSONValue.string))])
            }
        }
    }
    private func acceptTriage(_ issues: [PathwayIssueRecord], statusID: String) {
        update(issues, patch: ["triage": .bool(false), "statusId": .string(statusID)])
    }
    private func rejectTriage(_ issues: [PathwayIssueRecord]) {
        perform {
            for issue in issues {
                _ = try await model.mutate(companyID: issue.companyId, kind: "issue.triageReject", entityID: issue.id, args: [:])
            }
        }
    }
    private func errorBanner(_ message: String) -> some View {
        HStack {
            Image(systemName: "exclamationmark.circle")
            Text(message).font(.footnote)
            Spacer()
            if model.pendingChangeCount > 0 {
                Button("Retry") { perform { try await model.retryPendingChanges() } }
                    .disabled(model.isWriting)
            } else {
                Button {
                    errorMessage = nil; model.clearError()
                } label: { Image(systemName: "xmark").frame(width: 32, height: 32) }
                    .accessibilityLabel("Dismiss error")
            }
        }
        .foregroundStyle(.red)
        .padding(.horizontal, 18)
        .padding(.vertical, 8)
        .accessibilityIdentifier("issue-write-error")
    }

    @State private var showingDeleted = false
}

private extension PathwayIssuesView {
    var filterSheet: some View {
        PathwayIssueFilterSheet(
            configuration: $configuration,
            statuses: statuses, labels: labels,
            milestones: model.milestones.filter { $0.companyId == companyID },
            cycles: model.cycles.filter { $0.companyId == companyID },
            members: model.members.filter { $0.companyId == companyID },
            projects: companyProjects,
            saveView: {
                showsFilters = false
                savedViewName = ""
                showsSaveView = true
            }
        )
    }

    var savedViewsSheet: some View {
        NavigationStack {
            List {
                if let message = errorMessage ?? model.errorMessage { errorBanner(message) }
                if showingDeleted {
                    let deleted = companyRecords.filter(\.isDeleted).sorted { $0.updatedAt > $1.updatedAt }
                    if deleted.isEmpty {
                        ContentUnavailableView("No deleted issues", systemImage: "trash")
                    }
                    ForEach(deleted, id: \.id) { issue in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(issue.title).lineLimit(2)
                                Text(issue.key).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Restore") { perform { try await model.restore(issue) } }
                                .disabled(model.isWriting)
                        }
                    }
                } else {
                    if views.isEmpty { Text("Save your current filters as a view to find them here.").foregroundStyle(.secondary) }
                    ForEach(views, id: \.id) { view in
                        Button {
                            configuration = PathwayIssueListConfiguration(json: view["config"] ?? .object([:]))
                            activeViewID = view.id
                            scope = .all
                            showsSavedViews = false
                        } label: {
                            HStack {
                                Label(view.name, systemImage: "line.3.horizontal.decrease.circle")
                                Spacer()
                                if PathwayIssueListConfiguration(json: view["config"] ?? .object([:])) == savedConfiguration {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                        .contextMenu {
                            Button("Rename", systemImage: "pencil") { renameText = view.name; renamingViewID = view.id }
                            Button("Move up", systemImage: "arrow.up") { moveView(view, offset: -1) }
                                .disabled(views.first?.id == view.id)
                            Button("Move down", systemImage: "arrow.down") { moveView(view, offset: 1) }
                                .disabled(views.last?.id == view.id)
                        }
                        .swipeActions {
                            Button("Delete", role: .destructive) {
                                perform {
                                    _ = try await model.mutate(companyID: view.companyId, kind: "issueView.delete", entityID: view.id, args: [:])
                                    if activeViewID == view.id { activeViewID = nil }
                                }
                            }
                        }
                    }
                    Section {
                        Button("Save current view", systemImage: "plus") {
                            showsSavedViews = false; savedViewName = ""; showsSaveView = true
                        }
                        if let activeViewID, let current = views.first(where: { $0.id == activeViewID }) {
                            Button("Update \(current.name)", systemImage: "arrow.triangle.2.circlepath") {
                                perform {
                                    _ = try await model.mutate(companyID: current.companyId, kind: "issueView.update", entityID: current.id, args: ["config": savedConfiguration.json])
                                    showsSavedViews = false
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(showingDeleted ? "Recently deleted" : "Saved views")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { showsSavedViews = false } }
            }
            .alert("Rename view", isPresented: Binding(get: { renamingViewID != nil }, set: { if !$0 { renamingViewID = nil } })) {
                TextField("View name", text: $renameText)
                Button("Cancel", role: .cancel) { renamingViewID = nil }
                Button("Rename") { renameView() }
                    .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    var savedConfiguration: PathwayIssueListConfiguration {
        var config = configuration
        if scope == .mine, let membershipID = company?.membershipId {
            config.assignees = ["member:\(membershipID)"]
        }
        return config
    }

    func saveView() {
        guard let companyID else { return }
        let name = savedViewName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let existing = views.first { $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame }
        let id = existing?.id ?? UUID().uuidString.lowercased()
        let config = savedConfiguration.json
        perform {
            _ = try await model.mutate(companyID: companyID, kind: existing == nil ? "issueView.create" : "issueView.update", entityID: id, args: ["name": .string(name), "config": config])
            activeViewID = id
        }
    }

    func renameView() {
        guard let id = renamingViewID, let companyID else { return }
        let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renamingViewID = nil
        guard !name.isEmpty else { return }
        if views.contains(where: { $0.id != id && $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame }) {
            errorMessage = "A view with this name already exists."
            return
        }
        perform { _ = try await model.mutate(companyID: companyID, kind: "issueView.update", entityID: id, args: ["name": .string(name)]) }
    }

    func moveView(_ view: PathwayIssueEntity, offset: Int) {
        var ordered = views
        guard let index = ordered.firstIndex(where: { $0.id == view.id }), ordered.indices.contains(index + offset) else { return }
        ordered.swapAt(index, index + offset)
        perform {
            for (position, entry) in ordered.enumerated() {
                _ = try await model.mutate(companyID: entry.companyId, kind: "issueView.update", entityID: entry.id, args: ["position": .number(Double(position + 1))])
            }
        }
    }
}

private enum IssueMoveDestination { case top, up, down, bottom }

private struct IssueNavigationDestination: Hashable {
    let companyID: String
    let issueID: String
}

private struct IssuePresentation: Identifiable {
    let id = UUID()
    let companyID: String
    var issueID: String?
    var parentID: String?
    var statusID: String?
}

private enum IssueListRow: Identifiable {
    case header(IssueListGroup)
    case issue(PathwayIssueRecord)

    var id: String {
        switch self {
        case .header(let group): "header:" + group.id
        case .issue(let issue): "issue:" + issue.identity
        }
    }
    var issue: PathwayIssueRecord? {
        if case .issue(let issue) = self { issue } else { nil }
    }
    var dropEntry: PathwayIssueListDropEntry {
        switch self {
        case .header(let group): .init(issueID: nil, statusID: group.statusID)
        case .issue(let issue): .init(issueID: issue.id, statusID: issue.statusId)
        }
    }
}

private struct IssueListGroup: Identifiable {
    let id: String
    let title: String
    let statusID: String?
    let issues: [PathwayIssueRecord]
}

struct PathwayIssueStatusGlyph: View {
    let category: String
    let hexColor: String?

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(color)
            .frame(width: 18, height: 22)
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch category {
        case "started": "circle.lefthalf.filled"
        case "review": "clock.circle.fill"
        case "completed": "checkmark.circle.fill"
        case "canceled": "xmark.circle"
        case "backlog": "circle.dashed"
        case "triage": "tray"
        default: "circle"
        }
    }

    private var color: Color {
        if let hexColor {
            var hex = hexColor.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
            if let value = UInt32(hex, radix: 16) {
                return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
            }
        }
        return switch category {
        case "started": .orange
        case "review", "completed": .green
        default: .secondary
        }
    }
}

private struct PathwayIssueAssigneeGlyph: View {
    let token: String?
    let name: String

    var body: some View {
        Group {
            if token?.hasPrefix("agent:") == true {
                Image(systemName: "sparkles").font(.caption)
            } else if token != nil {
                Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()).font(.system(size: 10, weight: .semibold))
                    .frame(width: 20, height: 20)
                    .background(.quaternary, in: Circle())
            } else {
                Image(systemName: "person.crop.circle.dashed").font(.system(size: 18))
            }
        }
        .foregroundStyle(.secondary)
        .frame(width: 22)
        .accessibilityHidden(true)
    }
}
