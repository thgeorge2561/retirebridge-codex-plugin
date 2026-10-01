# RetireBridge for Codex

Build an educational retirement bridge scenario in Codex, run model previews locally, and continue on [Rest of the Road](https://restoftheroad.com/import?source=codex) with a plan file you choose to import.

## Install

Requires Codex with plugin marketplaces and Node.js 24 or newer.

```sh
codex plugin marketplace add thgeorge2561/retirebridge-codex-plugin
codex plugin add retirebridge@retirebridge-public
```

Start a new Codex task and ask: “Help me build a retirement bridge scenario.” You can also open an existing `.retirebridge.json` file by giving its absolute path.

To pick up a new plugin release later, run `codex plugin marketplace upgrade retirebridge-public`, then `codex plugin add retirebridge@retirebridge-public`. Start a new Codex task so it loads the updated tools.

## What it does

- Guides Household, Savings, Income, Spending, and Outlook intake.
- Runs the planned path, Monte Carlo simulation, lever comparison, and tax comparison using a bundle of the website's model code.
- Requires explicit core financial inputs before modeling or exporting.
- Writes a `.retirebridge.json` plan file to Downloads by default. You select that file on the website, review its summary, and decide whether to replace the current browser draft.

The Codex intake covers core fields. Use the website for detailed inputs, charts, saved scenarios, and a full review. Results are educational scenarios, not forecasts or personalized financial advice.

## Privacy

The plugin's MCP server and model calculations run on your machine. Exported plan files stay on your machine unless you choose to share them. The website import page reads a selected file in your browser and does not upload it. Financial details typed into the Codex conversation or passed to plugin tools follow Codex data handling. Avoid account numbers, tax identifiers, exact addresses, and credentials.

## Verify this package

```sh
npm test
```

The checked-in `plugins/retirebridge/scripts/model.mjs` is a bundle of the RetireBridge website's deterministic model code. No install step or API key is needed. The plugin manifest and marketplace entry are under `plugins/retirebridge/` and `.agents/plugins/marketplace.json`.
The bundled Zod dependency's license is in `THIRD_PARTY_LICENSES/ZOD.txt`.

For support or privacy questions, use [Rest of the Road contact](https://restoftheroad.com/contact) without including plan values.
