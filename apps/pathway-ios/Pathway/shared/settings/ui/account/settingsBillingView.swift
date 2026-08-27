import SwiftUI

@MainActor
struct SettingsBillingView: View {
    private struct Content {
        let billing: SettingsBillingSnapshot?
        let invoices: [SettingsBillingInvoice]
        let pause: SettingsAccountPauseState?
    }

    let service: any SettingsBillingServicing
    let locale: Locale

    @State private var state: SettingsAccountLoadState<Content> = .loading
    @State private var reloadID = UUID()

    var body: some View {
        Group {
            switch state {
            case .loading:
                Form {
                    Section("Current Plan") { SettingsAccountLoadingRows(count: 3) }
                    Section("Invoices") { SettingsAccountLoadingRows(count: 3) }
                }
            case let .failed(message):
                SettingsAccountErrorView(message: message) { reloadID = UUID() }
            case let .loaded(content):
                billingForm(content)
            }
        }
        .navigationTitle("Billing")
        .task(id: reloadID) { await load() }
    }

    private func billingForm(_ content: Content) -> some View {
        Form {
            if let billing = content.billing {
                Section("Current Plan") {
                    LabeledContent("Plan") {
                        Text(billing.plan.planName)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Status") {
                        SettingsStatusLabel(
                            status: billing.plan.billingStatus ?? billing.companyData.accountStatus
                        )
                    }
                    LabeledContent("Users") {
                        Text(billing.usersTotal.total.formatted(.number.precision(.fractionLength(0))))
                    }
                    if let interval = billing.plan.planInterval, !interval.isEmpty {
                        LabeledContent("Billing cycle", value: interval.capitalized)
                    }
                    if let nextInvoice = SettingsAccountFormatting.dateText(
                        billing.plan.nextInvoiceDate,
                        locale: locale
                    ) {
                        LabeledContent("Next invoice", value: nextInvoice)
                    }
                }

                Section {
                    if billing.companyData.details.billingEmails.isEmpty {
                        LabeledContent("Billing email", value: "Not set")
                    } else {
                        ForEach(billing.companyData.details.billingEmails, id: \.self) { email in
                            LabeledContent("Billing email") {
                                Text(email)
                                    .multilineTextAlignment(.trailing)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    LabeledContent("Payment method") {
                        Text(billing.companyData.hasActivePaymentMethod ? "On file" : "Not on file")
                    }
                } header: {
                    Text("Billing Details")
                } footer: {
                    Text("Plan, payment and billing changes remain available in Pathway on the web. This app does not start purchases or upgrades.")
                }
            } else {
                Section {
                    ContentUnavailableView(
                        "Billing Unavailable",
                        systemImage: "creditcard",
                        description: Text("Billing information isn't available for this company.")
                    )
                }
            }

            if let pause = content.pause {
                Section("Account Status") {
                    LabeledContent("Subscription") {
                        SettingsStatusLabel(status: pause.status)
                    }
                    if let date = SettingsAccountFormatting.dateText(pause.pauseEndsAt, locale: locale) {
                        LabeledContent("Pause ends", value: date)
                    }
                    Button {} label: {
                        HStack {
                            SettingsIconLabel("Retention offer", systemName: "tag", color: .orange)
                            Spacer()
                            Text("Coming soon")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(true)
                    .accessibilityLabel("Retention offer, coming soon")
                }
            }

            Section {
                if content.invoices.isEmpty {
                    ContentUnavailableView(
                        "No Invoices Yet",
                        systemImage: "doc.text",
                        description: Text("Invoices appear here after your first charge.")
                    )
                } else {
                    ForEach(content.invoices) { invoice in
                        invoiceRow(invoice)
                    }
                }
            } header: {
                Text("Invoices")
            } footer: {
                Text("Invoice history is read-only in the app.")
            }
        }
        .refreshable { await load() }
    }

    private func invoiceRow(_ invoice: SettingsBillingInvoice) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(invoice.invoiceNumber.isEmpty ? "Invoice" : invoice.invoiceNumber)
                    .font(.body.weight(.medium))
                Spacer()
                Text(
                    SettingsAccountFormatting.money(
                        minorUnits: invoice.totalMinorUnits,
                        currencyCode: invoice.currencyCode,
                        locale: locale
                    )
                )
                .foregroundStyle(.secondary)
            }
            HStack {
                Text(
                    SettingsAccountFormatting.dateText(
                        invoice.issuedAt ?? invoice.dueAt,
                        locale: locale
                    ) ?? invoice.billingMonthKey
                )
                .font(.subheadline)
                .foregroundStyle(.secondary)
                Spacer()
                SettingsStatusLabel(status: invoice.status)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        if case .loaded = state {} else { state = .loading }
        do {
            let billing = try await service.loadBilling()
            let invoices = try await service.loadInvoices()
            let pause = try await service.loadPauseState()
            let content = Content(billing: billing, invoices: invoices, pause: pause)
            try Task.checkCancellation()
            state = .loaded(content)
        } catch is CancellationError {
            return
        } catch {
            state = .failed(SettingsAccountFormatting.displayError(error))
        }
    }
}
