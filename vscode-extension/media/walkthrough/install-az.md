# Install the Azure CLI

Fabric Data Factory signs in to Microsoft Fabric through the **Azure CLI** (`az`).
It shells out to `az account get-access-token`, so `az` must be installed and
resolvable on the PATH that VS Code inherits.

1. [Install Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
2. **Restart VS Code** afterwards so the extension host picks up your updated PATH.

> Tip: if `az` works in a terminal but the extension still can't find it, VS Code
> was probably launched before `az` was on the PATH — restart it.
