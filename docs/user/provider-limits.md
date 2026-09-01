# Provider limits

Pathway shows how much of each provider's usage allowance you have left, so you can see when an agent is about to hit a rate limit. Limit bars appear in the thread details panel's **Usage** section, in **Settings → Providers**, and in the account menu.

Each signed-in provider account shows a bar per limit window with the percentage remaining and when it resets. Codex accounts show the 5-hour and weekly windows. Claude accounts show the 5-hour session, the weekly limit, and any model-specific weekly allowances your plan includes (for example a separate Fable or Opus row). Cursor accounts show the current billing period. When a provider adds a new kind of limit, it appears automatically.

Limits update live while agents run. If a provider can't be reached, Pathway keeps the last known values and shows how old they are (for example "as of 12m ago") instead of clearing the bars. If a bar shows **Not signed in**, sign in with that provider's CLI (for example `codex` or `claude`) and the bar recovers on the next refresh.

Use the refresh button beside the bars to fetch the latest values immediately. If a provider is rate-limiting refreshes, Pathway shows how long the pause has left and waits automatically. Restarting Pathway does not reset that pause.
