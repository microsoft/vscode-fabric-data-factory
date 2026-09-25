# Verify your setup

Run the **Setup Doctor** to check everything end to end without needing the
native addon:

- `az` is found on the extension's PATH and its version
- you're signed in (`az account show` — user, tenant, cloud)
- a token for the Fabric scope can actually be acquired

[Run Setup Doctor](command:fabricDataFactory.runSetupDoctor)

The report is copied to your clipboard so you can share it if you need help.
The Fabric token's value is never captured — only whether it could be acquired.
