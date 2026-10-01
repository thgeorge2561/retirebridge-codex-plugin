---
name: retirebridge
description: Guide a user through a retirement bridge scenario in Codex, run the site's local models, and hand a plan file to the Rest of the Road website.
---

# RetireBridge in Codex

Use the `retirebridge` MCP tools when a user wants to build, open, or explore a RetireBridge plan. The tools bundle the website's scenario builder and model code. Do not calculate projections, taxes, account access, or simulated success in prose.

## Guided intake

1. Call `start_intake`. The returned `session_id` lasts two hours in this Codex session.
2. Work through the five returned steps: Household, Savings, Income, Spending, and Outlook. Ask a few related questions at a time. Use `get_intake` to revisit a step. Send values through `answer_intake` for the corresponding step.
3. Treat `source: "default"` as a model assumption or unanswered value. Never describe it as a fact supplied by the user. Financial fields begin at zero. Ask the user to enter `0` explicitly when an amount is genuinely zero or unknown; explain that a missing Social Security estimate can materially change the result.
4. Money is in annual USD or account balances as each question says. Rates are decimal fractions: `0.05` means 5%. Do not ask for Social Security numbers, account numbers, exact addresses, or credentials.
5. Run `run_model` after `missing_for_model` is empty. Start with `planned_path`. Offer `monte_carlo`, `levers`, and `tax_comparison` for specific follow-up questions. Describe Monte Carlo output as a model simulation based on assumptions, not as a forecast of the user's real-world probability of success.

For an existing plan, ask the user for the absolute path to their `.retirebridge.json` file and call `open_plan_file`. The file remains on their machine; financial details provided in the Codex conversation and tool calls follow Codex's data handling.

## Website transition

Offer the handoff once the core intake is complete and the user has seen a brief model preview. Bring the user to the website sooner if they want detailed charts, a full field-by-field review, saved scenarios, or the richer interactive results. Call `export_plan` and provide its `file_path` and `website_url` as clickable links. The export writes a private local plan file, normally in Downloads.

On the website, the user selects that file, sees a summary, and chooses **Open in planner**. The site then opens at the first setup step. If the browser already has a current draft, the review screen offers a backup before replacement. The import page reads the file in the browser and does not upload it. Do not imply that the website can read a local file automatically from a URL or that the Codex plan has already appeared there.

The Codex intake covers the core fields. The website remains the place to inspect advanced inputs and detailed output. Do not claim the handoff succeeded before the user completes the import.
