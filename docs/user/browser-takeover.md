# Browser takeover

Some browser work only you can do: signing in, clearing a consent dialog, picking a card in a
payment sandbox, or putting a page into the exact state the agent needs. Browser takeover pauses the
agent, hands you its Preview browser, and then lets the agent carry on from whatever you left on
screen.

## Take over

While an agent is working and has used the Preview browser during the current run, a **Take over to
assist agent** callout appears above the composer. Select **Take over** to claim the browser.

Pathway then:

1. Finishes any browser action the agent already started and blocks new ones.
2. Stops the agent's current task.
3. Opens the exact tab the agent was driving and gives it to you.

The banner shows **Pausing agent…** until all three are done. Nothing is handed over early, so the
agent is never clicking the same page as you.

Once the browser is yours, the banner reads **Agent paused — you have control**. Use the Preview
browser normally: navigate, sign in, fill fields, dismiss dialogs.

## Hand the browser back

Two ways to finish, both on the takeover banner:

- **Proceed** returns the browser to the agent and continues the thread. The agent picks up from the
  browser's current state — the page you left open, still signed in, still where you put it. You do
  not need to describe what you did; Pathway tells the agent to continue from the current Preview
  tab.
- **End takeover** returns the browser to the agent without starting anything. The thread stays
  paused, and you can send your own message whenever you want.

## Who can take over

Only the Pathway desktop that is hosting the Preview browser can take it over — it is the one with
the actual window. Other devices signed into the same thread see the takeover status ("the browser
is under manual control on another Pathway desktop") and can still select **Proceed** when you are
ready, but the page itself is prepared on the hosting desktop.

## If something goes wrong

If the agent finishes before the handover completes, the banner says so and nothing is paused —
there was no work left to interrupt.

If the takeover cannot complete — the hosting desktop disconnects, or the server restarts mid
handover — Pathway keeps the browser blocked for the agent rather than handing back a page you might
still be using. The banner explains what happened and offers **Release browser lease** to give the
browser back to the agent.

If the agent could not be resumed after **Proceed**, you keep the browser and the banner offers
**Retry** or **End takeover**.
