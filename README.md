# Fabric Data Factory for VS Code

Fabric Data Factory is a Visual Studio Code extension for browsing, editing, and managing Microsoft Fabric Data Factory items.

## Features

- Browse Fabric workspaces and Data Factory items from VS Code.
- Edit item definitions locally with JSON validation and IntelliSense.
- Pull changes from Fabric and push local updates.
- Work with pipelines, Copy Jobs, Dataflows Gen2, dbt jobs, and Airflow jobs.
- Run Airflow jobs locally and use the built-in `@di` chat assistant.

## Prerequisites

Install the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), ensure `az` is available on your `PATH`, and sign in before using the extension:

```sh
az login
```

Restart VS Code after installing the Azure CLI so the extension can detect it.

## Get started

See the [extension guide](./vscode-extension/README.md) for requirements, installation, authentication, and usage.

## Development

The extension source is in [`vscode-extension`](./vscode-extension).

```sh
cd vscode-extension
npm install
npm run typecheck
npm run build
```

To report a problem or suggest an improvement, [open an issue](https://github.com/microsoft/vscode-fabric-data-factory/issues).
