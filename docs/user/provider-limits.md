# Provider limits

Pathway shows how much of each provider's usage allowance you have left, so you can see when an agent is about to hit a rate limit. Limit bars appear in the thread details panel's **Usage** section, in **Settings → Providers**, and in the account menu.

For an existing thread, **Usage** follows the account running the work on its environment. Selecting another account in the composer prepares your next submission; it does not change the running account or its usage display.

Each signed-in provider account shows a bar per limit window with the percentage remaining and when it resets. Codex accounts show the 5-hour and weekly windows. Claude accounts show the 5-hour session, the weekly limit, and any model-specific weekly allowances your plan includes (for example a separate Fable or Opus row). Cursor accounts show the current billing period. When a provider adds a new kind of limit, it appears automatically.

Limits update live while agents run. If a provider can't be reached, Pathway keeps the last known values and shows how old they are (for example "as of 12m ago") instead of clearing the bars. If a bar shows **Not signed in**, sign in with that provider's CLI (for example `codex` or `claude`) and the bar recovers on the next refresh.

Use the refresh button beside the bars to fetch the latest values immediately. If a provider is rate-limiting refreshes, Pathway shows how long the pause has left and waits automatically. Restarting Pathway does not reset that pause.

While a client is connected, Pathway checks for quota updates in the background. Successful snapshots are refreshed after about five minutes; unavailable data is retried about once a minute, subject to the provider's retry delay. Codex can also push updates while agents run. Model-specific Codex allowances remain separate from the general allowance.

The account menu and Settings group the same Codex subscription across connected environments and show its freshest available usage. Different subscriptions remain separate, even when they share an email. Environments that do not report an account identity, and other providers, remain separate. Changing a configured credential home invalidates its previous quota and retry state.

When offering to wait after a usage-limit failure, Pathway prefers the reset time in the provider's failure message. Otherwise it uses the latest reset among the exhausted windows that apply to the selected model. Unknown or stale reset information does not schedule automatic recovery.

Thread details and the profile usage menu hide Claude usage when that account is not signed in. Check Settings → Providers to see its sign-in status.

Spark quotas remain visible in Settings → Providers. Thread details show them only while a Spark model is selected; the profile usage menu hides them.

The Lunar Reserve quota appears only in Settings → Providers. It is hidden from thread details and the profile usage menu.

## Usage reset credits

Codex accounts with available usage reset credits show them below the usage meters in **Settings → Providers** and at the bottom of the profile menu's **Provider usage** submenu. Each credit shows when it expires.

Select **Redeem** beside a credit, then confirm to use it on that account. Redeeming spends the credit and resets the account's current usage limits. It cannot be undone. Pathway refreshes the account's usage and available credits afterward. If the provider cannot confirm the result, Pathway shows an error; retrying the same credit does not spend a different one.

Credits belong to the provider account shown beside them. For a remote environment, Pathway sends the redemption to that environment. Viewing usage does not require permission to operate the environment, but redeeming a credit does. Providers that do not report reset credits do not show a redemption action.

If the credit balance cannot be refreshed, Pathway keeps the last balance and disables redemption until a successful refresh. Usage meters can still update while credit information is unavailable.
