# Fabric Data Factory for VS Code

Browse, edit, and manage your Microsoft Fabric **Data Factory** items — Pipelines,
dbt Jobs, Airflow Jobs, Copy Jobs, and Dataflows Gen2 — directly from VS Code, with
a native file-editing experience, JSON IntelliSense, and an AI assistant.

This guide walks you through installing and setting up the extension so you can sign
in to Fabric and start working with your items.

---

## What you can do

- **Browse** your Fabric workspaces and Data Factory items in a dedicated sidebar.
- **Edit** item definitions locally with full JSON schema validation and IntelliSense.
- **Push / Pull** changes to and from Fabric with ETag-based conflict detection.
- **Run Airflow locally** — start a standalone Airflow server that mimics the remote
  environment so you can test DAGs before publishing.
- **Ask `@di`** — a built-in chat assistant that generates and runs scripts against
  your Fabric workspaces, Airflow DAGs, and Lakehouse tables.

---

## Requirements

| Requirement | Needed for | Notes |
|---|---|---|
| **VS Code 1.116+** | Everything | [Download](https://code.visualstudio.com/) |
| **Azure CLI** (`az`) | Sign-in & all Fabric operations | Must be installed and on your `PATH`. See below. |
| **Python 3.9–3.12** on `PATH` | Local Airflow server, `@di` chat scripts | Install **Python 3.12** — the local Airflow server is pinned to **2.10.5**, which only supports Python 3.9–3.12 (not 3.13/3.14). `python3.12 --version` should succeed. |
| **WSL** (Windows only) | Local standalone Airflow server | The Airflow server runs only on POSIX (Linux/macOS). See [Windows setup](#windows-setup-wsl). |

### Check whether a tool is on your `PATH`

Use the command for your shell to confirm `az` and `python3`/`python` are installed
and discoverable. If a command prints a path, the tool is on your `PATH`; if it prints
nothing (or an error), install the tool or fix your `PATH`.

| Shell / OS | Azure CLI | Python |
|---|---|---|
| **Linux / macOS** (bash, zsh) | `which az` | `which python3` |
| **Windows** (Command Prompt) | `where az` | `where python` |
| **Windows** (PowerShell) | `Get-Command az` | `Get-Command python` |

---

## 1. Install the Azure CLI and sign in

The extension authenticates to Fabric through the Azure CLI. You must install it and
sign in before selecting a workspace.

1. Install the Azure CLI: <https://learn.microsoft.com/cli/azure/install-azure-cli>
2. Sign in from a terminal:

   ```sh
   az login
   ```

   Use `az login --tenant <tenant-id>` if your Fabric workspaces live in a specific
   tenant.
3. Confirm you are signed in:

   ```sh
   az account show
   ```

> If the extension can't find the Azure CLI or you aren't signed in, it will prompt
> you to install it or run `az login`.

---

## 2. Install Python 3.12 (for local features)

Local Airflow and the `@di` chat assistant run Python scripts, so a Python runtime
must be available on your `PATH`.

> **Install Python 3.12 specifically.** The local Airflow server is pinned to
> **Apache Airflow 2.10.5**, which only publishes dependency constraints for
> Python **3.9–3.12**. A newer default interpreter (3.13 / 3.14) makes the Airflow
> install fail (the constraints file for it does not exist). The extension
> automatically prefers a `python3.12` on your `PATH`, so installing it alongside
> a newer system Python is enough.

- **Linux / macOS**: Install Python 3.12 from your package manager, e.g.
  `sudo apt install python3.12 python3.12-venv`. Verify with `python3.12 --version`.
  If you want `python3` itself to resolve to 3.12, register it with
  `update-alternatives`:

  ```sh
  sudo update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1
  ```
- **Windows**: Install Python 3.12 **inside WSL** (see the next section), not on the
  Windows host — the local Airflow server only runs in a POSIX environment.

The extension creates and manages its own virtual environment and installs Airflow
dependencies automatically; you only need a compatible base interpreter available.

---

## Windows setup (WSL)

The local standalone Airflow server is **only supported on POSIX platforms
(Linux/macOS)**. On Windows you must run VS Code connected to **WSL** so the extension
can start Airflow in a Linux environment that mimics the remote Fabric Airflow runtime.

### Install WSL

1. Open **PowerShell as Administrator** and run:

   ```powershell
   wsl --install
   ```

   This installs WSL 2 and a default Ubuntu distribution. Restart when prompted.
2. Launch **Ubuntu** from the Start menu and complete the first-run user setup.
3. Inside Ubuntu, install Python 3.12 and the Azure CLI:

   ```sh
   sudo apt update
   sudo apt install -y python3.12 python3.12-venv python3-pip
   # Optional: make `python3` resolve to 3.12
   sudo update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1
   curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
   az login
   ```

   > Python 3.12 is required because the local Airflow server is pinned to
   > **2.10.5** (Python 3.9–3.12 only).

### Open VS Code in WSL

1. Install the [WSL extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-wsl)
   for VS Code.
2. From WSL, open your project folder in VS Code:

   ```sh
   code .
   ```

   The window title bar shows **WSL: Ubuntu** when connected.
3. Install this extension in the WSL context and continue with the steps below.

> On macOS and Linux, no WSL is needed — everything runs natively.

---

## 3. Install the extension

- **From the Marketplace**: search for **Fabric Data Factory** in the Extensions view
  and click **Install**.
- **From a VSIX**:

  ```sh
  code --install-extension fabric-data-factory-0.1.0.vsix
  ```

Reload VS Code afterward. The **Fabric Data Factory** icon appears in the Activity Bar.

---

## 4. Connect to a workspace

1. Open a folder in VS Code — this is where item definitions are synced locally.
2. Click the **Fabric Data Factory** icon in the Activity Bar.
3. Click **Select Workspaces** and pick the Fabric workspace(s) you want to work with.
4. Your Data Factory items appear in the tree, grouped by type.

Click any item to download its definition and open it in the editor. Edit, then use
**Push Item** to save your changes back to Fabric, or **Pull Item** to refresh from
the remote copy.

---

## Working with Airflow locally

Once you've synced an Airflow job, you can run it against a local standalone Airflow
server that mimics the remote environment (Linux/macOS, or Windows + WSL):

1. Right-click an Airflow item and choose **Run in Local Airflow**, or run
   **Fabric: Start Airflow Server** from the Command Palette.
2. The extension sets up a virtual environment, installs Airflow, and starts the
   server. Progress streams to the **Airflow** output channel.
3. Use **Open Airflow Web UI** to view DAGs, **Show Airflow Logs** to inspect output,
   and **Stop Airflow Server** when finished.

---

## The `@di` chat assistant

Open the Chat view and mention **`@di`** to generate and run scripts that interact with
your Fabric workspaces, Airflow DAGs, and Lakehouse tables.

Useful sub-commands:

- `@di /continue` — resume the previous agent loop after a step limit.
- `@di /reset` — reset the sandbox and clear all variables.
- `@di /reportError` — summarize errors from the chat and draft a bug report.

---

## Supported item types

| Item type | Fabric type | Edit experience |
|---|---|---|
| **Pipeline** | `DataPipeline` | JSON schema + IntelliSense |
| **Copy Job** | `CopyJob` | JSON schema + IntelliSense |
| **Dataflow Gen2** | `Dataflow` | Power Query (`.pq`) + metadata JSON |
| **dbt Job** | `DataBuildToolJob` | Full project files (models, macros, seeds) |
| **Airflow Job** | `ApacheAirflowJob` | DAGs, plugins, `requirements.txt` + local run |

> **Tip:** For the best experience, also install the
> [Python](https://marketplace.visualstudio.com/items?itemName=ms-python.python),
> [dbt Power User](https://marketplace.visualstudio.com/items?itemName=innoverio.vscode-dbt-power-user),
> and Power Query / M language extensions.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Azure CLI is required but not found or not signed in" | Install the Azure CLI and run `az login`. |
| Airflow won't start on Windows | Run VS Code connected to WSL — the server is POSIX-only. |
| "Airflow standalone runner is only supported on POSIX platforms" | Same as above: use Linux, macOS, or WSL. |
| Airflow install fails on `constraints-3.13.txt` / `constraints-3.14.txt` (404) | Your default Python is too new for Airflow 2.10.5. Install **Python 3.12** (`sudo apt install python3.12 python3.12-venv`); the extension will prefer it automatically. |
| Local Airflow / `@di` scripts fail immediately | Ensure a compatible Python (3.9–3.12) is installed and on your `PATH`. |
| No workspaces listed | Confirm `az account show` returns the tenant that owns your Fabric workspaces. |
