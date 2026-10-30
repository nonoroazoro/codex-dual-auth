# codex-dual-auth

Switch between API and OAuth with shared Codex conversations.

- `codex` uses your API key.
- `codex-official` uses your ChatGPT account.

Both share configuration and conversations, with separate authentication.

## Setup with an agent

Paste this into Codex, Claude Code, or another coding agent:

```text
Set up https://github.com/nonoroazoro/codex-dual-auth on my computer.
Follow its README and verify with `codex doctor`.
```

## Setup

Requires **Node.js 22+** and **Codex CLI**.

Windows requires **Developer Mode** or an **Administrator terminal**.

1. Install dependencies from this project directory:

   ```sh
   npm ci
   ```

2. Run setup:

   ```sh
   node src/cli.mjs setup
   ```

3. Provide any missing API settings.
4. Open a new terminal.
5. Check the installation:

   ```sh
   codex doctor
   ```

ChatGPT sign-in starts when you first use `codex-official`.

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
node src/cli.mjs --help   # Setup options
```

Tested on macOS. Windows execution is not yet verified.
