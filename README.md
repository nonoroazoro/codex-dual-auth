# codex-dual-auth

Switch between API and OAuth with shared Codex conversations.

- `codex` uses your API key.
- `codex-official` uses your ChatGPT account.

Both commands use the same Codex installation, configuration, and conversation history. Authentication stays separate, and each session starts without the background daemon.

## Setup

Requires **Node.js 22+** and an installed **Codex CLI**. Start with a clean Codex configuration; setup will not overwrite an existing unmanaged configuration.

On Windows, enable **Developer Mode** or use an **Administrator terminal** to create file links.

1. Run from this project directory:

   ```sh
   node src/cli.mjs setup
   ```

2. Enter your API endpoint, model, and API key when prompted.
3. Follow the prompts to configure PATH and sign in to ChatGPT.
4. Open a new terminal.
5. Check the installation:

   ```sh
   codex doctor
   ```

If Windows has not refreshed PATH, run this in PowerShell:

```powershell
$env:Path = "$HOME\.local\bin;" + $env:Path
```

## Use

```sh
codex                                  # Use API authentication
codex-official                         # Use ChatGPT OAuth
codex resume <conversation-id>          # Continue through the API
codex-official resume <conversation-id> # Continue through OAuth
```

Finish the current turn before switching commands for the same conversation.

```sh
codex setup              # Rerun without replacing correct configuration
codex doctor             # Check configuration and authentication
codex-official login     # Sign in to ChatGPT
node src/cli.mjs --help   # Setup options
```

Tested locally on macOS; Windows execution is not yet verified. Local checks: `npm run check`, `npm test`, and `node scripts/native-check.mjs`.
